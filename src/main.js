import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { Readable } from 'node:stream';
import qrcode from 'qrcode-generator';
import { Adb, AdbError, findAdb, inputCommand, streamSize, wifiPairingPayload } from './adb.js';
import { AppMetaStore } from './appmeta.js';
import { ThumbnailStore } from './thumbs.js';

app.setName('Mooner Explorer');

// 파일 탭 미리보기: 기기 파일을 adb로 바로 스트리밍하는 mooner-preview://f/<serial>/<경로> 프로토콜 (Range 지원).
protocol.registerSchemesAsPrivileged([{ scheme: 'mooner-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
nativeTheme.themeSource = 'dark';

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

const adb = new Adb({ binary: () => findAdb(settings.adbPath) });
let appMeta = null; // AppMetaStore
let thumbs = null; // ThumbnailStore, created once app paths are available
const logcats = new Map();
const shellRuns = new Map();
const qrRuns = new Map();
let mainWindow = null;

const windowOf = event => BrowserWindow.fromWebContents(event.sender);
const serialOf = value => {
  if (typeof value !== 'string' || !value) throw new AdbError('기기가 선택되지 않았습니다.');
  return value;
};

const screens = new Map();
const SCREEN_QUALITY = {
  tiny: { maxSide: 640, bitrate: 1_000_000 }, low: { maxSide: 960, bitrate: 2_000_000 }, normal: { maxSide: 1280, bitrate: 4_000_000 },
  high: { maxSide: 1600, bitrate: 6_000_000 }, ultra: { maxSide: 1920, bitrate: 8_000_000 }, original: { maxSide: Infinity, bitrate: 12_000_000 },
};

const screenEpoch = new Map();

function stopScreen(id) {
  screenEpoch.set(id, (screenEpoch.get(id) ?? 0) + 1);
  const screen = screens.get(id);
  if (!screen) return;
  screens.delete(id);
  screen.stop?.();
  screen.input.close();
}

function stopLogcat(id) {
  const stream = logcats.get(id);
  if (!stream) return;
  logcats.delete(id);
  clearInterval(stream.timer);
  stream.stop();
}

const PREVIEW_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  pdf: 'application/pdf',
};

// 썸네일이 한꺼번에 수백 장 요청돼도 adb 프로세스가 폭증하지 않도록 이미지 요청은 동시에 몇 개만 처리한다.
const imageSlots = { free: 6, waiting: [] };
function acquireImageSlot(signal) {
  if (imageSlots.free > 0) { imageSlots.free--; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const waiter = () => { signal.removeEventListener('abort', onAbort); resolve(); };
    const onAbort = () => { imageSlots.waiting = imageSlots.waiting.filter(item => item !== waiter); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    imageSlots.waiting.push(waiter);
  });
}
function releaseImageSlot() {
  const next = imageSlots.waiting.shift();
  if (next) next(); else imageSlots.free++;
}

async function handlePreview(request) {
  let slot = false;
  const releaseSlot = () => { if (slot) { slot = false; releaseImageSlot(); } };
  try {
    const url = new URL(request.url);
    const [, serial, ...segments] = url.pathname.split('/').map(decodeURIComponent);
    const remote = `/${segments.join('/')}`;
    const type = PREVIEW_MIME[remote.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
    if (type.startsWith('image/')) { await acquireImageSlot(request.signal); slot = true; }
    // 썸네일 요청은 목록에서 이미 아는 크기를 ?size=로 넘겨 stat용 adb 호출을 한 번 아낀다.
    const known = Number(url.searchParams.get('size'));
    const size = url.searchParams.has('size') && Number.isSafeInteger(known) && known >= 0 ? known : await adb.fileSize(serialOf(serial), remote);
    const headers = {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    let start = 0, end = size - 1, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]));
      else { start = Number(range[1]); if (range[2] !== '') end = Math.min(end, Number(range[2])); }
      if (start > end) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    const length = Math.max(0, end - start + 1);
    headers['Content-Length'] = String(length);
    if (!length) { releaseSlot(); return new Response(null, { status, headers }); }
    const child = adb.readRange(serial, remote, start, length);
    child.on('error', releaseSlot);
    child.stdout.once('close', () => { releaseSlot(); child.kill(); });
    request.signal.addEventListener('abort', () => { releaseSlot(); child.kill(); });
    return new Response(Readable.toWeb(child.stdout), { status, headers });
  } catch (error) {
    releaseSlot();
    return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
  }
}

// PC 탐색기로 끌어내기: startDrag는 시작 시점에 실제 파일이 필요해서 기기 파일을 임시 폴더로 미리 받아 둔다.
const exportRoot = () => path.join(app.getPath('temp'), 'mooner-explorer', 'export');
const exportCache = new Map();

async function exportPath(serial, item) {
  const remote = String(item.remote);
  const key = [serial, remote, item.size, item.modified].join('|');
  const cached = exportCache.get(key);
  if (cached) {
    const file = await cached.catch(() => null);
    if (file && fs.existsSync(file)) return file;
    exportCache.delete(key);
  }
  const folder = path.join(exportRoot(), createHash('sha1').update(key).digest('hex').slice(0, 16));
  const pulled = (async () => {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    return (await adb.pull(serial, [remote], folder))[0];
  })();
  exportCache.set(key, pulled);
  try { return await pulled; } catch (error) { exportCache.delete(key); throw error; }
}

const thumbItem = item => ({ remote: String(item?.remote), size: Number(item?.size) || 0, modified: String(item?.modified ?? '') });

const handlers = {
  'view:setDevMode'(_event, enabled) {
    settings.devMode = Boolean(enabled);
    saveSettings();
    buildMenu(); // 메뉴의 체크 표시를 맞춘다
    return settings.devMode;
  },
  async 'app:status'() {
    const binary = findAdb(settings.adbPath);
    let version = null, error = null;
    if (binary) try { version = await adb.version(); } catch (e) { error = e.message; }
    return { adbPath: binary, customAdbPath: settings.adbPath ?? null, adbVersion: version, error, platform: process.platform, appVersion: app.getVersion(), devMode: settings.devMode === true };
  },
  async 'settings:pickAdb'(event) {
    const result = await dialog.showOpenDialog(windowOf(event), {
      title: 'adb 실행 파일 선택',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'adb', extensions: ['exe'] }] : [],
    });
    return result.canceled ? null : result.filePaths[0];
  },
  'settings:setAdbPath'(_event, adbPath) {
    if (adbPath && !findAdb(adbPath)) throw new AdbError(`파일이 없습니다: ${adbPath}`);
    if (adbPath) settings.adbPath = adbPath; else delete settings.adbPath;
    saveSettings();
    return handlers['app:status']();
  },
  'adb:restart': () => adb.restartServer().then(() => true),
  'adb:connect': (_event, address) => adb.connect(String(address).trim()),
  'adb:pair': (_event, address, code) => adb.pair(String(address).trim(), String(code).trim()),
  'adb:disconnect': (_event, serial) => adb.disconnect(serialOf(serial)),
  // QR 페어링: QR 이미지를 만들어 돌려주고, 기기가 스캔할 때까지의 대기는 adb:qrWait가 맡는다.
  'adb:qrStart'(event) {
    qrRuns.get(event.sender.id)?.abort();
    const name = `mooner-${randomInt(100000, 999999)}`;
    const password = String(randomInt(100000, 999999));
    const qr = qrcode(0, 'M');
    qr.addData(wifiPairingPayload(name, password));
    qr.make();
    const controller = new AbortController();
    qrRuns.set(event.sender.id, Object.assign(controller, { name, password }));
    return { svg: qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true }) };
  },
  async 'adb:qrWait'(event) {
    const run = qrRuns.get(event.sender.id);
    if (!run) throw new AdbError('진행 중인 QR 페어링이 없습니다.');
    try { return await adb.pairWithQr(run.name, run.password, { signal: run.signal }); }
    finally { if (qrRuns.get(event.sender.id) === run) qrRuns.delete(event.sender.id); }
  },
  'adb:qrCancel'(event) {
    qrRuns.get(event.sender.id)?.abort();
    qrRuns.delete(event.sender.id);
    return true;
  },

  'devices:list': () => adb.devices(),
  'device:info': (_event, serial) => adb.info(serialOf(serial)),
  'device:stats': (_event, serial) => adb.stats(serialOf(serial)),
  'device:reboot': (_event, serial, mode) => adb.reboot(serialOf(serial), ['recovery', 'bootloader', 'sideload'].includes(mode) ? mode : undefined),
  'device:wireless': (_event, serial) => adb.enableWireless(serialOf(serial)),

  'files:list': (_event, serial, dir) => adb.list(serialOf(serial), String(dir || '/')),
  'files:isDir': (_event, serial, remote) => adb.isDirectory(serialOf(serial), String(remote)),
  async 'files:pull'(event, serial, remotes) {
    const result = await dialog.showOpenDialog(windowOf(event), { title: '저장할 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    const folder = result.filePaths[0];
    await adb.pull(serialOf(serial), remotes, folder);
    return folder;
  },
  async 'files:open'(_event, serial, remote) {
    const folder = path.join(app.getPath('temp'), 'mooner-explorer', serialOf(serial).replace(/[^\w.-]/g, '_'));
    fs.mkdirSync(folder, { recursive: true });
    const [file] = await adb.pull(serial, [remote], folder);
    const error = await shell.openPath(file);
    if (error) throw new AdbError(error);
  },
  async 'files:push'(event, serial, dir, locals) {
    if (!locals?.length) {
      const result = await dialog.showOpenDialog(windowOf(event), { title: '기기로 보낼 파일 선택', properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return 0;
      locals = result.filePaths;
    }
    await adb.push(serialOf(serial), locals, dir);
    return locals.length;
  },
  async 'files:pushFolder'(event, serial, dir) {
    const result = await dialog.showOpenDialog(windowOf(event), { title: '기기로 보낼 폴더 선택', properties: ['openDirectory'] });
    if (result.canceled) return 0;
    await adb.push(serialOf(serial), result.filePaths, dir);
    return result.filePaths.length;
  },
  'files:transfer': (_event, serial, sources, dest, mode) => adb.transfer(serialOf(serial), sources.map(String), String(dest), mode === 'move' ? 'move' : 'copy'),
  async 'files:prepareExport'(_event, serial, items) {
    await Promise.all(items.map(item => exportPath(serialOf(serial), item)));
    return true;
  },
  // 끌어내기를 OS에 넘긴다. 탐색기가 "이동"으로 처리하면 임시 파일이 사라지므로 그것으로 이동 여부를 알아낸다(놓은 위치는 알 수 없다).
  async 'files:startExport'(event, serial, items) {
    const files = await Promise.all(items.map(item => exportPath(serialOf(serial), item)));
    event.sender.startDrag({ file: files[0], files, icon: await app.getFileIcon(files[0]) });
    const gone = () => items.filter((_item, index) => !fs.existsSync(files[index])).map(item => item.remote);
    for (let waited = 0; waited < 10_000; waited += 400) {
      await new Promise(resolve => setTimeout(resolve, 400));
      if (gone().length) break;
    }
    return { moved: gone() };
  },
  'files:thumb': (_event, serial, item) => thumbs.get(serialOf(serial), thumbItem(item)),
  'files:thumbStore': (_event, serial, item, data) => thumbs.put(serialOf(serial), thumbItem(item), data),
  'files:delete': (_event, serial, remotes) => adb.remove(serialOf(serial), remotes),
  'files:mkdir': (_event, serial, remote) => adb.mkdir(serialOf(serial), remote),
  'files:move': (_event, serial, from, to) => adb.move(serialOf(serial), from, to),

  'apps:list': (_event, serial, kind) => adb.packages(serialOf(serial), kind),
  'apps:meta': (_event, serial, apk) => appMeta.get(serialOf(serial), String(apk ?? '')),
  'apps:info': (_event, serial, name) => adb.packageInfo(serialOf(serial), name),
  async 'apps:install'(event, serial, files) {
    if (!files?.length) {
      const result = await dialog.showOpenDialog(windowOf(event), { title: '설치할 APK 선택', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Android 패키지', extensions: ['apk'] }] });
      if (result.canceled) return [];
      files = result.filePaths;
    }
    const results = [];
    for (const file of files) {
      try { await adb.install(serialOf(serial), file); results.push({ file: path.basename(file), ok: true }); }
      catch (error) { results.push({ file: path.basename(file), ok: false, error: error.message }); }
    }
    return results;
  },
  'apps:uninstall': (_event, serial, name) => adb.uninstall(serialOf(serial), name),
  'apps:launch': (_event, serial, name) => adb.launch(serialOf(serial), name),
  'apps:stop': (_event, serial, name) => adb.forceStop(serialOf(serial), name),
  'apps:clear': (_event, serial, name) => adb.clearData(serialOf(serial), name),
  'apps:setEnabled': (_event, serial, name, enabled) => adb.setEnabled(serialOf(serial), name, Boolean(enabled)),
  async 'apps:extract'(event, serial, name, apk) {
    const result = await dialog.showSaveDialog(windowOf(event), { title: 'APK 저장', defaultPath: `${name}.apk`, filters: [{ name: 'Android 패키지', extensions: ['apk'] }] });
    if (result.canceled) return null;
    const folder = fs.mkdtempSync(path.join(app.getPath('temp'), 'mooner-explorer-apk-'));
    try {
      const [file] = await adb.pull(serialOf(serial), [apk], folder);
      fs.copyFileSync(file, result.filePath);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
    return result.filePath;
  },

  async 'screen:capture'(_event, serial) {
    return (await adb.screenshot(serialOf(serial))).toString('base64');
  },
  async 'screen:save'(event, base64) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const result = await dialog.showSaveDialog(windowOf(event), { title: '스크린샷 저장', defaultPath: `screenshot-${stamp}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
    return result.filePath;
  },
  // 실시간 미러링. 화질 프리셋이 기기의 인코딩 부하(해상도·비트레이트)를 정한다.
  async 'screen:start'(event, serial, quality) {
    const id = event.sender.id, sender = event.sender;
    stopScreen(id);
    const preset = SCREEN_QUALITY[quality] ?? SCREEN_QUALITY.normal;
    const epoch = screenEpoch.get(id);
    const info = await adb.screenInfo(serialOf(serial));
    // 기기 정보를 읽는 동안 중지·재시작 요청이 왔다면 이 시작은 버린다.
    if (screenEpoch.get(id) !== epoch) throw new AdbError('화면 연결이 취소되었습니다.');
    const size = streamSize(info, preset.maxSide);
    const screen = { input: adb.openInput(serial), bounds: info, pending: null, stop: null, serial };
    screens.set(id, screen);
    const send = (channel, payload) => { if (!sender.isDestroyed() && screens.get(id) === screen) sender.send(channel, payload); };
    screen.stop = adb.mirror(serial, {
      ...size,
      bitrate: preset.bitrate,
      onFrame: frame => send('screen:frame', frame),
      onExit: message => { if (message !== null) send('screen:exit', message); },
    });
    return { width: info.width, height: info.height, motion: info.motion, stream: size };
  },
  'screen:stop'(event) {
    stopScreen(event.sender.id);
  },
  // 입력은 기기에서 한 번에 하나씩만 실행된다. 드래그 중 밀린 move는 가장 최근 것만 남기고 버린다.
  async 'screen:input'(event, serial, kind, value) {
    const screen = screens.get(event.sender.id);
    if (!screen || screen.serial !== serial) return adb.input(serialOf(serial), kind, value);
    const run = (k, v) => screen.input.run(inputCommand(k, v, screen.bounds)).then(() => {
      const next = screen.pending;
      screen.pending = null;
      if (next) return run('move', next);
    });
    if (kind === 'move' && screen.input.busy) { screen.pending = value; return; }
    if (kind !== 'move') screen.pending = null;
    await run(kind, value);
  },

  async 'shell:run'(event, serial, command) {
    const controller = new AbortController();
    shellRuns.set(event.sender.id, controller);
    try { return await adb.shellRaw(serialOf(serial), String(command), { timeout: 0, signal: controller.signal }); }
    finally { shellRuns.delete(event.sender.id); }
  },
  'shell:cancel'(event) {
    shellRuns.get(event.sender.id)?.abort();
  },

  'logcat:start'(event, serial) {
    const id = event.sender.id, sender = event.sender;
    stopLogcat(id);
    let pending = [];
    const stop = adb.logcat(serialOf(serial), {
      onLine: entry => pending.push(entry),
      onExit: message => {
        if (logcats.get(id)?.stop !== stop) return;
        stopLogcat(id);
        if (!sender.isDestroyed()) sender.send('logcat:exit', message);
      },
    });
    const timer = setInterval(() => {
      if (!pending.length || sender.isDestroyed()) return;
      sender.send('logcat:lines', pending);
      pending = [];
    }, 150);
    logcats.set(id, { stop, timer });
    return true;
  },
  'logcat:stop'(event) {
    stopLogcat(event.sender.id);
  },
  'logcat:clear': (_event, serial) => adb.clearLogcat(serialOf(serial)),
  async 'logcat:save'(event, content) {
    const result = await dialog.showSaveDialog(windowOf(event), { title: '로그 저장', defaultPath: 'logcat.txt', filters: [{ name: '텍스트', extensions: ['txt', 'log'] }] });
    if (result.canceled) return null;
    fs.writeFileSync(result.filePath, content);
    return result.filePath;
  },

  'os:showFolder': (_event, folder) => shell.openPath(folder),
};

// Errors are returned as values so the renderer sees the message without Electron's "Error invoking remote method" prefix.
ipcMain.handle('call', async (event, name, ...args) => {
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
  if (!handler) return { ok: false, error: `알 수 없는 요청: ${name}` };
  try { return { ok: true, value: await handler(event, ...args) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 600,
    title: 'Mooner Explorer',
    icon: path.join(import.meta.dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // 네이티브 프레임을 유지한 채 제목 표시줄만 숨긴다. 이동·크기 조절·스냅·최대화 상태 드래그 복원은 OS가 처리한다.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 13 } } : { titleBarOverlay: { color: '#171a20', symbolColor: '#8d95a3', height: 39 } }),
    backgroundColor: '#111317',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  const id = mainWindow.webContents.id;
  mainWindow.on('closed', () => { stopLogcat(id); stopScreen(id); shellRuns.get(id)?.abort(); qrRuns.get(id)?.abort(); qrRuns.delete(id); mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(path.join(import.meta.dirname, 'renderer', 'index.html'));
}

const devTools = process.argv.includes('--dev');
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '보기', submenu: [
      {
        label: '개발자 모드로 보기', type: 'checkbox', checked: settings.devMode === true,
        click: item => {
          settings.devMode = item.checked;
          saveSettings();
          mainWindow?.webContents.send('view:devMode', item.checked);
        },
      },
      { type: 'separator' },
      { role: 'reload', label: '새로 고침' }, ...(devTools ? [{ role: 'toggleDevTools', label: '개발자 도구' }] : []), { type: 'separator' }, { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' }, { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' }] },
    { role: 'editMenu', label: '편집' },
  ]));
}

// 개발 모드 핫 리로드: 렌더러/preload는 창만 새로 고치고, 메인 프로세스 코드(ESM)는 앱을 다시 시작한다.
function watchSources() {
  const debounced = (fn) => {
    let timer;
    return () => { clearTimeout(timer); timer = setTimeout(fn, 120); };
  };
  const reloadWindow = debounced(() => {
    if (!mainWindow) return;
    console.log('[dev] 렌더러 코드가 변경되어 창을 새로 고칩니다');
    mainWindow.webContents.reloadIgnoringCache();
  });
  const restartApp = debounced(() => {
    console.log('[dev] 메인 프로세스 코드가 변경되어 앱을 다시 시작합니다');
    for (const id of [...logcats.keys()]) stopLogcat(id);
    for (const run of shellRuns.values()) run.abort();
    app.exit(75); // scripts/dev.mjs가 같은 터미널에서 다시 실행한다
  });
  const watch = (target, options, onChange) => {
    try {
      const watcher = fs.watch(target, options, onChange);
      watcher.on('error', () => watcher.close());
    } catch (error) {
      console.warn(`개발 모드 파일 감시 실패 (${error.code || 'WATCH_FAILED'}). 변경 반영은 앱을 직접 재시작하세요.`);
    }
  };
  watch(path.join(import.meta.dirname, 'renderer'), { recursive: true }, reloadWindow);
  watch(import.meta.dirname, {}, (_event, name) => {
    if (name === 'preload.cjs') reloadWindow();
    else if (name === 'main.js' || name === 'adb.js') restartApp();
  });
}

app.whenReady().then(() => {
  loadSettings();
  buildMenu();
  fs.rmSync(exportRoot(), { recursive: true, force: true });
  protocol.handle('mooner-preview', handlePreview);
  appMeta = new AppMetaStore({ adb, dir: path.join(app.getPath('userData'), 'App Cache') });
  thumbs = new ThumbnailStore({ adb, dir: path.join(app.getPath('userData'), 'Thumbnail Cache') });
  setTimeout(() => thumbs.prune(256 * 1024 * 1024), 10_000);
  createWindow();
  if (devTools) watchSources();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('will-quit', () => fs.rmSync(exportRoot(), { recursive: true, force: true }));

app.on('window-all-closed', () => {
  for (const id of [...logcats.keys()]) stopLogcat(id);
  if (process.platform !== 'darwin') app.quit();
});
