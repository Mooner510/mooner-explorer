import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// 포터블 Windows 자동 업데이트: 저장소의 최신 GitHub 릴리스를 확인한다.
// 릴리스에는 패키징한 폴더의 zip 하나가 있고, 앱이 종료되면 PowerShell 도우미가 새 폴더를 설치 폴더에 그대로 덮어쓴 뒤
// 앱을 다시 실행한다. 사용자 데이터는 설치 폴더 밖의 %APPDATA%에 있다.

const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// 패키징한 복사본(exe + resources/app)만 스스로 업데이트한다. `pnpm dev`·`pnpm start`는 소스 폴더에서 실행된다.
const portable = () => process.platform === 'win32' && path.basename(path.dirname(app.getAppPath())) === 'resources';

const run = (file, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exit ${code}`)));
});

const APPLY = `param($ProcessId, $Source, $Target, $Exe)
Wait-Process -Id $ProcessId -ErrorAction SilentlyContinue
robocopy $Source $Target /MIR /R:30 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$ok = $LASTEXITCODE -lt 8
Start-Process -FilePath $Exe
if ($ok) { Remove-Item -LiteralPath (Split-Path $Source) -Recurse -Force -ErrorAction SilentlyContinue }
`;

const PROGRESS_PAGE = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:dark light}body{margin:0;padding:20px;font:14px system-ui,'Malgun Gothic',sans-serif;background:#1e1f22;color:#e6e6e6}
#text{margin-bottom:12px}.bar{height:8px;border-radius:4px;background:#3a3c40;overflow:hidden}
#fill{height:100%;width:0;background:#4c8bf5;transition:width .15s}#fill.wait{width:35%;animation:slide 1.1s ease-in-out infinite alternate}
@keyframes slide{from{margin-left:0}to{margin-left:65%}}</style>
<div id="text">준비 중…</div><div class="bar"><div id="fill" class="wait"></div></div>
<script>function set(text,fraction){document.getElementById('text').textContent=text;const f=document.getElementById('fill');
f.classList.toggle('wait',fraction==null);f.style.width=fraction==null?'':Math.round(fraction*100)+'%'}</script>`;

// 다운로드와 설치에 시간이 걸려 앱이 멈춘 것처럼 보이지 않도록, 작은 진행 창과 작업표시줄 진행률을 띄운다.
function progressWindow(parent) {
  const win = new BrowserWindow({ width: 380, height: 120, parent: parent ?? undefined, resizable: false, minimizable: false, maximizable: false, closable: false, show: false, autoHideMenuBar: true, title: '업데이트', webPreferences: { sandbox: true, contextIsolation: true } });
  win.setMenu(null);
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_PAGE)}`);
  win.once('ready-to-show', () => win.show());
  let last = 0;
  return {
    // fraction이 null이면 진행률을 알 수 없는 막대로 보여 준다.
    set(text, fraction = null, force = true) {
      const now = Date.now();
      if (!force && now - last < 100) return;
      last = now;
      if (!win.isDestroyed()) void win.webContents.executeJavaScript(`set(${JSON.stringify(text)}, ${fraction})`).catch(() => {});
      const main = parent && !parent.isDestroyed() ? parent : null;
      if (main) fraction === null ? main.setProgressBar(2, { mode: 'indeterminate' }) : main.setProgressBar(fraction);
    },
    close() {
      if (parent && !parent.isDestroyed()) parent.setProgressBar(-1);
      if (!win.isDestroyed()) win.destroy();
    },
  };
}

// 주기 확인, 시작 시 확인, 설정의 버튼이 겹칠 수 있으므로 한 번에 하나만 실행한다.
let busy = false;

const say = (window, options) => Promise.resolve(window ? dialog.showMessageBox(window, { buttons: ['확인'], ...options }) : dialog.showMessageBox({ buttons: ['확인'], ...options }));

// 'unsupported' | 'latest' | 'declined' | 'updating' | 'error' 중 하나를 돌려준다. `manual`(설정의 버튼)이면
// "최신 버전"과 실패도 대화상자로 알리고, 백그라운드 확인은 새 버전이 있을 때만 묻는다.
export async function checkForUpdate({ repo, asset, window, manual = false }) {
  if (!portable()) {
    if (manual) await say(window, { type: 'info', title: '업데이트', message: '설치형(포터블) 앱에서만 자동 업데이트를 지원합니다.', detail: '소스에서 실행 중이면 git pull로 직접 갱신하세요.' });
    return 'unsupported';
  }
  if (busy) return 'updating';
  busy = true;
  try { return await check({ repo, asset, window, manual }); }
  catch (error) {
    if (!manual) throw error;
    await say(window, { type: 'error', title: '업데이트', message: `업데이트를 확인하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` });
    return 'error';
  } finally { busy = false; }
}

async function check({ repo, asset, window, manual }) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': app.getName() };
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) throw new Error(`GitHub 응답 오류 (HTTP ${response.status})`);
  const release = await response.json();
  const version = String(release.tag_name).replace(/^v/, '');
  const file = release.assets?.find(item => item.name === asset);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion()) || !file) {
    if (manual) await say(window, { type: 'info', title: '업데이트', message: '최신 버전을 사용 중입니다.', detail: `현재 버전은 ${app.getVersion()}입니다.` });
    return 'latest';
  }
  const prompt = {
    type: 'info', buttons: ['업데이트 후 재시작', '나중에'], defaultId: 0, cancelId: 1, title: '업데이트',
    message: `새 버전 ${version}을 사용할 수 있습니다.`,
    detail: `현재 버전은 ${app.getVersion()}입니다. 업데이트를 받은 뒤 앱이 잠시 종료되었다가 다시 실행됩니다.`,
  };
  const { response: choice } = await (window ? dialog.showMessageBox(window, prompt) : dialog.showMessageBox(prompt));
  if (choice !== 0) return 'declined';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mooner-update-'));
  const progress = progressWindow(window);
  try {
    const zip = path.join(work, asset);
    progress.set(`v${version} 다운로드 준비 중…`);
    const download = await fetch(file.browser_download_url, { headers: { 'User-Agent': app.getName() } });
    if (!download.ok) throw new Error(`다운로드 실패 (HTTP ${download.status})`);
    const hash = createHash('sha256');
    const total = Number(download.headers.get('content-length')) || file.size || 0;
    const mb = bytes => (bytes / 1048576).toFixed(1);
    let received = 0;
    await pipeline(Readable.fromWeb(download.body), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk); received += chunk.length; yield chunk;
        progress.set(total ? `v${version} 다운로드 중… ${mb(received)} / ${mb(total)} MB` : `v${version} 다운로드 중… ${mb(received)} MB`, total ? Math.min(1, received / total) : null, false);
      }
    }, fs.createWriteStream(zip));
    progress.set('파일 검증 중…');
    // GitHub는 올린 파일마다 sha256 다이제스트를 기록한다. 일치하지 않으면 적용하지 않는다.
    if (file.digest !== `sha256:${hash.digest('hex')}`) throw new Error('받은 업데이트 파일의 해시가 릴리스와 다릅니다.');
    progress.set('압축 푸는 중…');
    const extracted = path.join(work, 'new');
    fs.mkdirSync(extracted);
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', extracted]);
    fs.rmSync(zip);
    const [folder] = fs.readdirSync(extracted);
    const source = path.join(extracted, folder ?? '');
    if (!folder || !fs.existsSync(path.join(source, path.basename(process.execPath)))) throw new Error('업데이트 파일 구성이 올바르지 않습니다.');
    const script = path.join(work, 'apply.ps1');
    fs.writeFileSync(script, APPLY);
    // Electron은 자기 프로세스를 Windows 잡 오브젝트에 넣고 종료할 때 함께 정리해서, detached 자식도 같이 죽는다.
    // Win32_Process.Create는 WMI 서비스가 도우미를 띄우므로 그 잡 밖에서 실행된다.
    const command = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, String(process.pid), source, path.dirname(process.execPath), process.execPath]
      .map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ');
    progress.set('설치를 위해 앱을 다시 시작합니다…');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MOONER_UPDATE_COMMAND }).ReturnValue'], { MOONER_UPDATE_COMMAND: command });
    // 진행 창은 앱이 종료될 때까지 남겨 두어, 재시작이 비정상 종료처럼 보이지 않게 한다.
    app.quit();
    return 'updating';
  } catch (error) {
    progress.close();
    fs.rmSync(work, { recursive: true, force: true });
    dialog.showErrorBox('업데이트', `업데이트하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 'error';
  }
}
