import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export class AdbError extends Error {}

// Device-side commands go through `sh -c`, so every user-supplied value is single-quoted.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function joinRemote(dir, name) {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentRemote(dir) {
  const trimmed = dir.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
}

// Local file name for a remote path; characters Windows forbids are replaced.
export function localName(remote) {
  const name = remote.replace(/\/+$/, '').split('/').pop() || 'root';
  return process.platform === 'win32' ? name.replace(/[<>:"\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '_') : name;
}

// "a.txt" → "a - 복사본.txt" → "a - 복사본 (2).txt" …, the first name not in `taken`.
export function uniqueName(taken, name) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = `${stem} - 복사본${n > 1 ? ` (${n})` : ''}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const PACKAGE_NAME =/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
export function assertPackage(name) {
  if (!PACKAGE_NAME.test(name)) throw new AdbError(`올바르지 않은 패키지 이름입니다: ${name}`);
  return name;
}

export function adbCandidates(env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const list = [];
  if (env.ADB_PATH) list.push(env.ADB_PATH);
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) if (env[key]) list.push(path.join(env[key], 'platform-tools', exe));
  if (platform === 'win32' && env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', exe));
  if (platform === 'darwin') list.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe), '/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  if (platform === 'linux') list.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe), '/usr/bin/adb');
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) if (dir) list.push(path.join(dir, exe));
  return list;
}

export function findAdb(custom) {
  const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  if (custom) return isFile(custom) ? custom : null;
  return adbCandidates().find(isFile) ?? null;
}

// ---- output parsers (pure, unit tested) ----

const lines = text => String(text).replace(/\r/g, '').split('\n');

export function parseDevices(text) {
  const devices = [];
  for (const line of lines(text)) {
    if (!line.trim() || line.startsWith('*') || line.startsWith('List of devices')) continue;
    const match = /^(\S+)\s+(no permissions|\S+)(.*)$/.exec(line);
    if (!match) continue;
    const [, serial, state, rest] = match;
    // "no permissions" is followed by free text (with URLs), so only the known key:value tokens are read.
    const props = {};
    for (const token of rest.trim().split(/\s+/)) {
      const prop = /^(usb|product|model|device|transport_id):(.*)$/.exec(token);
      if (prop) props[prop[1]] = prop[2];
    }
    devices.push({
      serial,
      state,
      model: props.model?.replace(/_/g, ' ') ?? null,
      product: props.product ?? null,
      device: props.device ?? null,
      transportId: props.transport_id ?? null,
      wireless: /:\d+$/.test(serial) || serial.includes('._adb-tls-connect.'),
    });
  }
  return devices;
}

export function parseGetprop(text) {
  const props = {};
  for (const line of lines(text)) {
    const match = /^\[(.+?)\]: \[(.*)\]$/.exec(line);
    if (match) props[match[1]] = match[2];
  }
  return props;
}

const BATTERY_STATUS = { 1: '알 수 없음', 2: '충전 중', 3: '방전 중', 4: '충전 안 함', 5: '완충' };
export function parseBattery(text) {
  const values = {};
  for (const line of lines(text)) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (match) values[match[1].trim()] = match[2].trim();
  }
  if (!('level' in values)) return null;
  const powered = ['AC powered', 'USB powered', 'Wireless powered', 'Dock powered'].filter(key => values[key] === 'true').map(key => key.split(' ')[0]);
  return {
    level: Number(values.level),
    scale: Number(values.scale || 100),
    status: BATTERY_STATUS[values.status] ?? values.status ?? null,
    temperature: values.temperature ? Number(values.temperature) / 10 : null,
    voltage: values.voltage ? Number(values.voltage) / 1000 : null,
    health: values.health ?? null,
    powered,
  };
}

// `df -k <path>`; long filesystem names wrap onto a second line on older devices.
export function parseDf(text) {
  const body = lines(text).filter(line => line.trim() && !/^Filesystem/i.test(line)).join(' ');
  const numbers = body.trim().split(/\s+/).filter(token => /^\d+$/.test(token)).map(Number);
  if (numbers.length < 3) return null;
  const [total, used, free] = numbers;
  return { total: total * 1024, used: used * 1024, free: free * 1024 };
}

// `/proc/meminfo` (kB). MemAvailable is missing on very old kernels, so fall back to free + cached.
export function parseMeminfo(text) {
  const values = {};
  for (const line of lines(text)) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  }
  if (!values.MemTotal) return null;
  const available = values.MemAvailable ?? (values.MemFree ?? 0) + (values.Cached ?? 0);
  return { total: values.MemTotal, available, used: values.MemTotal - available };
}

// First line of `/proc/stat`: cumulative jiffies. CPU usage is the busy share between two samples.
export function parseCpuStat(text) {
  const match = /^cpu\s+(.+)$/m.exec(text);
  if (!match) return null;
  const fields = match[1].trim().split(/\s+/).map(Number);
  if (fields.length < 4 || fields.some(Number.isNaN)) return null;
  const idle = fields[3] + (fields[4] ?? 0);
  return { idle, total: fields.slice(0, 8).reduce((sum, value) => sum + value, 0) };
}

// `/sys/devices/system/cpu/possible`, e.g. "0-7" or "0-3,6-7".
export function parseCpuRange(text) {
  const ranges = text.trim().split(',').filter(Boolean);
  let count = 0;
  for (const range of ranges) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range.trim());
    if (!match) return null;
    count += (match[2] == null ? 0 : Number(match[2]) - Number(match[1])) + 1;
  }
  return count || null;
}

export function parseWmSize(text) {
  const physical = /Physical size:\s*(\d+x\d+)/.exec(text)?.[1] ?? null;
  const override = /Override size:\s*(\d+x\d+)/.exec(text)?.[1] ?? null;
  return override ?? physical;
}

export function parseWmDensity(text) {
  return /Override density:\s*(\d+)/.exec(text)?.[1] ?? /Physical density:\s*(\d+)/.exec(text)?.[1] ?? null;
}

// ---- screen mirroring helpers (pure, unit tested) ----

// Shell command for one input event. Coordinates are clamped to the display so a drag past the edge stays valid.
export function inputCommand(kind, value, bounds) {
  const clamp = (n, max) => Math.round(Math.min(Math.max(Number(n) || 0, 0), max ?? Infinity));
  const point = (x, y) => [clamp(x, bounds && bounds.width - 1), clamp(y, bounds && bounds.height - 1)];
  if (kind === 'key') return `input keyevent ${Math.round(Number(value))}`;
  if (kind === 'tap') return `input tap ${point(value.x, value.y).join(' ')}`;
  if (kind === 'swipe') return `input swipe ${[...point(value.x1, value.y1), ...point(value.x2, value.y2), Math.round(value.duration ?? 200)].join(' ')}`;
  if (kind === 'down' || kind === 'move' || kind === 'up') return `input motionevent ${kind.toUpperCase()} ${point(value.x, value.y).join(' ')}`;
  // `input text` treats spaces as separators; %s is its escape for a space.
  if (kind === 'text') return `input text ${shellQuote(String(value).replace(/ /g, '%s'))}`;
  throw new AdbError(`알 수 없는 입력 종류: ${kind}`);
}

// Display size as the touch screen sees it: `wm size` is the natural orientation, so 90°/270° rotation swaps the axes.
export function displaySize(wmSize, rotation = 0) {
  const match = /^(\d+)x(\d+)$/.exec(wmSize ?? '');
  if (!match) return null;
  const [width, height] = [Number(match[1]), Number(match[2])];
  return rotation % 2 ? { width: height, height: width } : { width, height };
}

export function parseRotation(text) {
  const match = /(?:SurfaceOrientation|mCurrentRotation|rotation)[=:]\s*(?:ROTATION_)?(\d+)/i.exec(text);
  const value = match ? Number(match[1]) : 0;
  return value >= 90 ? (value / 90) % 4 : value % 4;
}

// Scales so the longer side is at most `maxSide`, in multiples of 16 (what hardware encoders accept). Never upscales.
export function streamSize({ width, height }, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const round = value => Math.max(16, Math.round((value * scale) / 16) * 16);
  return { width: round(width), height: round(height) };
}

// Splits a raw H.264 Annex B byte stream (`screenrecord --output-format=h264`) into access units.
// Parameter sets (SPS/PPS) are held back and prepended to the next slice, so every key frame decodes on its own.
export class H264Splitter {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.params = [];
    this.sps = null;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const starts = [];
    for (let i = this.buffer.indexOf(0x01); i !== -1 && i >= 2; i = this.buffer.indexOf(0x01, i + 1)) {
      if (this.buffer[i - 1] === 0 && this.buffer[i - 2] === 0) starts.push(i - 2 - (i >= 3 && this.buffer[i - 3] === 0 ? 1 : 0));
    }
    // The last NAL may still be growing, so only the ones followed by another start code are complete.
    for (let n = 0; n + 1 < starts.length; n++) this.nal(this.buffer.subarray(starts[n], starts[n + 1]));
    if (starts.length > 1) this.buffer = this.buffer.subarray(starts.at(-1));
    else if (!starts.length && this.buffer.length > 4 * 1024 * 1024) this.buffer = Buffer.alloc(0);
  }

  nal(data) {
    const offset = data[2] === 1 ? 3 : 4;
    const type = data[offset] & 0x1f;
    if (type === 7) { this.sps = data.subarray(offset); this.params = [data]; return; }
    if (type === 8) { this.params.push(data); return; }
    if (type !== 1 && type !== 5) return;
    const payload = this.params.length ? Buffer.concat([...this.params, data]) : data;
    this.params = [];
    // avc1.PPCCLL from the profile, constraint flags and level bytes of the SPS.
    const codec = this.sps && `avc1.${[...this.sps.subarray(1, 4)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    this.started = true;
    this.onFrame({ key: type === 5, codec, data: payload });
  }
}

export function mirrorError(text, code) {
  if (/UNASSIGNED_LAYER_STACK|display.*(off|not)/i.test(text)) return '기기 화면이 꺼져 있습니다. “화면 켜기” 버튼으로 화면을 켠 뒤 다시 연결하세요.';
  return text || `화면 스트림이 종료되었습니다 (exit ${code}).`;
}

export function parseIpv4(text) {
  return /inet (\d+\.\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

// `adb mdns services` rows: "<name>\t<_adb-tls-pairing._tcp|_adb-tls-connect._tcp>\t<ip>:<port>".
export function parseMdnsServices(text) {
  const services = [];
  for (const line of lines(text)) {
    const match = /^(\S+)\s+(_adb[\w-]*\._tcp)\.?\s+(\S+:\d+)\s*$/.exec(line.trim());
    if (match) services.push({ name: match[1], type: match[2], address: match[3] });
  }
  return services;
}

// Payload of the QR code that Android's "Pair device with QR code" screen scans.
export function wifiPairingPayload(name, password) {
  return `WIFI:T:ADB;S:${name};P:${password};;`;
}

const LS_LINE =/^([-dlcbps][-rwxsStTl]{9}[.+@]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:,\s*\d+)?)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s(.*)$/;
const LS_TYPE = { '-': 'file', d: 'dir', l: 'link' };
export function parseLs(text) {
  const entries = [];
  for (const line of lines(text)) {
    const match = LS_LINE.exec(line);
    if (!match) continue;
    const [, permissions, , owner, group, size, date, time, rest] = match;
    const type = LS_TYPE[permissions[0]] ?? 'other';
    let name = rest, target = null;
    if (type === 'link') {
      const index = rest.indexOf(' -> ');
      if (index >= 0) { name = rest.slice(0, index); target = rest.slice(index + 4); }
    }
    if (name === '.' || name === '..') continue;
    entries.push({ name, type, size: size.includes(',') ? null : Number(size), modified: `${date} ${time.slice(0, 5)}`, permissions, owner, group, target });
  }
  const rank = entry => (entry.type === 'dir' || entry.type === 'link' ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export function parsePackages(text) {
  const packages = [];
  for (const line of lines(text)) {
    if (!line.startsWith('package:')) continue;
    const body = line.slice('package:'.length).trim();
    const index = body.lastIndexOf('=');
    if (index < 0) packages.push({ name: body, apk: null });
    else packages.push({ name: body.slice(index + 1), apk: body.slice(0, index) });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

export function parsePackageInfo(text) {
  const pick = pattern => pattern.exec(text)?.[1] ?? null;
  return {
    versionName: pick(/versionName=(\S+)/),
    versionCode: pick(/versionCode=(\d+)/),
    targetSdk: pick(/targetSdk=(\d+)/),
    minSdk: pick(/minSdk=(\d+)/),
    firstInstallTime: pick(/firstInstallTime=([^\n\r]+)/),
    lastUpdateTime: pick(/lastUpdateTime=([^\n\r]+)/),
    installer: pick(/installerPackageName=(\S+)/),
  };
}

const LOGCAT_LINE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.*?)\s*: (.*)$/;
export function parseLogcatLine(line) {
  const match = LOGCAT_LINE.exec(line);
  if (!match) return { time: '', pid: '', tid: '', level: '', tag: '', message: line };
  const [, time, pid, tid, level, tag, message] = match;
  return { time, pid, tid, level, tag, message };
}

// ---- process runner ----

function runFile(file, args, { timeout = 30_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout, signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) return reject(new AdbError(`adb를 실행할 수 없습니다 (${file}).`));
      if (error?.name === 'AbortError') return reject(new AdbError('명령이 취소되었습니다.'));
      if (error?.killed) return reject(new AdbError(`명령 시간이 초과되었습니다 (${Math.round(timeout / 1000)}초).`));
      resolve({ stdout, stderr, code: typeof error?.code === 'number' ? error.code : error ? 1 : 0 });
    });
  });
}

// Splits readHeads output: per file an "@<length>\n" line, then that many raw bytes.
export function parseHeads(buffer, count) {
  const heads = [];
  let pos = 0;
  while (heads.length < count) {
    const newline = buffer.indexOf(0x0a, pos);
    const match = newline >= 0 && /^@(\d+)$/.exec(buffer.toString('latin1', pos, newline));
    if (!match) break;
    const start = newline + 1, end = start + Number(match[1]);
    if (end > buffer.length) break;
    heads.push(buffer.subarray(start, end));
    pos = end;
  }
  return heads;
}

// The aliases a path on the primary shared storage may be written with.
const PRIMARY_STORAGE = /^\/(?:storage\/emulated\/0|storage\/self\/primary|sdcard|mnt\/sdcard)(?=\/)/;
export const primaryPath = remote => (PRIMARY_STORAGE.test(remote) ? remote.replace(PRIMARY_STORAGE, '') : null);

// `content query ... --projection _id:_data` rows → Map of path under primary storage ("/Pictures/a.png") → MediaStore _id.
export function parseMediaIds(output) {
  const ids = new Map();
  for (const [, id, data] of output.matchAll(/^Row: \d+ _id=(\d+), _data=(.+)$/gm)) {
    const local = primaryPath(data);
    if (local) ids.set(local, id);
  }
  return ids;
}

const text = buffer => buffer.toString('utf8').replace(/\r\n/g, '\n');

// Output of Adb#shellBatch: each command's output followed by "\n<mark>\n". The extra echo guarantees
// the mark starts its own line even when a command's output has no trailing newline.
const SECTION_MARK = '__MOONER_SECTION__';
export function splitSections(output, count) {
  const parts = output.split(`\n${SECTION_MARK}\n`);
  return Array.from({ length: count }, (_, index) => (parts[index] ?? '').replace(/\n$/, ''));
}

export class Adb {
  constructor({ binary, run = runFile, spawnProcess = spawn } = {}) {
    this.binary = binary;
    this.run = run;
    this.spawnProcess = spawnProcess;
  }

  bin() {
    const binary = typeof this.binary === 'function' ? this.binary() : this.binary;
    if (!binary) throw new AdbError('adb를 찾을 수 없습니다. 설정에서 adb 경로를 지정하거나 Android SDK Platform-Tools를 설치하세요.');
    return binary;
  }

  async raw(args, options) {
    const { stdout, stderr, code } = await this.run(this.bin(), args, options);
    return { stdout, stderr, code };
  }

  async exec(args, options) {
    const { stdout, stderr, code } = await this.raw(args, options);
    const out = text(stdout), err = text(stderr);
    if (code !== 0) throw new AdbError((err || out).trim() || `adb ${args[0]} 실패 (exit ${code})`);
    return out;
  }

  shellRaw(serial, command, options) {
    return this.raw(['-s', serial, 'shell', command], options).then(({ stdout, stderr, code }) => ({ stdout: text(stdout), stderr: text(stderr), code }));
  }

  async shell(serial, command, options) {
    const { stdout, stderr, code } = await this.shellRaw(serial, command, options);
    if (code !== 0) throw new AdbError((stderr || stdout).trim() || `명령 실패 (exit ${code})`);
    return stdout;
  }

  async version() {
    const out = await this.exec(['version']);
    return /version ([\d.]+)/.exec(out)?.[1] ?? out.split('\n')[0];
  }

  // ro.build.characteristics에 tablet이 있으면 태블릿, 없으면 화면 최소 너비(600dp 이상)로 판단한다.
  async detectTablet(serial) {
    const read = async command => (await this.shell(serial, command).catch(() => '')).trim();
    if (/tablet/i.test(await read('getprop ro.build.characteristics'))) return true;
    const size = parseWmSize(await read('wm size'));
    const density = Number(parseWmDensity(await read('wm density')));
    if (!size || !density) return false;
    return Math.min(...size.split('x').map(Number)) / (density / 160) >= 600;
  }

  async devices() {
    const devices = parseDevices(await this.exec(['devices', '-l']));
    this.names ??= new Map();
    this.tablets ??= new Map();
    await Promise.all(devices.map(async device => {
      if (device.state !== 'device') return;
      if (!this.names.has(device.serial)) {
        const read = async command => (await this.shell(device.serial, command).catch(() => '')).trim();
        const name = await read('getprop persist.sys.device_name') || await read('settings get global device_name') || await read('getprop ro.product.marketname');
        this.names.set(device.serial, name && name !== 'null' ? name : null);
      }
      device.name = this.names.get(device.serial);
      if (!this.tablets.has(device.serial)) this.tablets.set(device.serial, await this.detectTablet(device.serial));
      device.tablet = this.tablets.get(device.serial);
    }));
    return devices;
  }

  // Runs several commands in one `adb shell` and returns each one's stdout ('' when it fails).
  // Starting an adb process blocks the Electron main thread for tens of ms on Windows, so batching keeps the UI smooth.
  async shellBatch(serial, commands, options) {
    const script = commands.map(command => `(${command}) 2>/dev/null; echo; echo ${SECTION_MARK}`).join('\n');
    return splitSections(await this.shell(serial, script, options), commands.length);
  }

  async info(serial) {
    const [props, battery, storage, size, density, wlan, uptime, meminfo, kernel, cpus] = await this.shellBatch(serial, [
      'getprop',
      'dumpsys battery',
      'df -k /data',
      'wm size',
      'wm density',
      'ip -f inet addr show wlan0',
      'cat /proc/uptime',
      'cat /proc/meminfo',
      'uname -r',
      'cat /sys/devices/system/cpu/possible',
    ]);
    const p = parseGetprop(props);
    if (!Object.keys(p).length) throw new AdbError('기기 속성(getprop)을 읽지 못했습니다.');
    return {
      serial,
      manufacturer: p['ro.product.manufacturer'] ?? null,
      brand: p['ro.product.brand'] ?? null,
      model: p['ro.product.model'] ?? null,
      device: p['ro.product.device'] ?? null,
      name: p['persist.sys.device_name'] || p['ro.product.marketname'] || null,
      androidVersion: p['ro.build.version.release'] ?? null,
      sdk: p['ro.build.version.sdk'] ?? null,
      securityPatch: p['ro.build.version.security_patch'] ?? null,
      build: p['ro.build.display.id'] ?? null,
      abi: p['ro.product.cpu.abi'] ?? null,
      hardwareSerial: p['ro.serialno'] || null,
      battery: parseBattery(battery),
      storage: parseDf(storage),
      resolution: parseWmSize(size),
      density: parseWmDensity(density),
      ip: parseIpv4(wlan),
      uptime: Number(uptime.split(/\s+/)[0]) || null,
      memory: parseMeminfo(meminfo),
      kernel: kernel.trim().split(/\s+/)[0] || null,
      cpuCores: parseCpuRange(cpus),
      soc: [p['ro.soc.manufacturer'], p['ro.soc.model']].filter(Boolean).join(' ') || p['ro.board.platform'] || p['ro.hardware'] || null,
      buildType: p['ro.build.type'] ?? null,
      bootState: p['ro.boot.verifiedbootstate'] ?? null,
    };
  }

  // Cheap sample for the live monitor; each part may be unavailable on locked-down devices.
  async stats(serial) {
    const [stat, meminfo, battery] = await this.shellBatch(serial, ['head -n 1 /proc/stat', 'cat /proc/meminfo', 'dumpsys battery']).catch(() => ['', '', '']);
    const parsed = parseBattery(battery);
    return {
      at: Date.now(),
      cpu: parseCpuStat(stat),
      memory: parseMeminfo(meminfo),
      battery: parsed && { level: parsed.level / parsed.scale * 100, temperature: parsed.temperature, status: parsed.status },
    };
  }

  // A trailing slash makes `ls` list the contents of symlinked directories such as /sdcard.
  async list(serial, dir) {
    const target = dir.endsWith('/') ? dir : `${dir}/`;
    const { stdout, stderr, code } = await this.shellRaw(serial, `ls -la ${shellQuote(target)}`);
    const entries = parseLs(stdout);
    if (code !== 0 && entries.length === 0) throw new AdbError((stderr || stdout).trim() || `폴더를 열 수 없습니다: ${dir}`);
    return entries;
  }

  async isDirectory(serial, remote) {
    const { stdout } = await this.shellRaw(serial, `[ -d ${shellQuote(remote)} ] && echo dir || echo file`);
    return stdout.trim() === 'dir';
  }

  async remoteKind(serial, remote) {
    const q = shellQuote(remote);
    const { stdout } = await this.shellRaw(serial, `if [ -d ${q} ]; then echo dir; elif [ -e ${q} ]; then echo file; fi`);
    return stdout.trim() || null;
  }

  // `adb pull` on Windows mangles non-ASCII local paths (it cannot write into "C:\…\한글폴더\" at all), so files are
  // streamed through `exec-out cat` and written by Node instead. Returns the local path of each pulled item.
  async pull(serial, remotes, localDir) {
    const targets = [];
    for (const remote of remotes) {
      const target = path.join(localDir, localName(remote));
      await this.pullEntry(serial, remote, target);
      targets.push(target);
    }
    return targets;
  }

  async pullEntry(serial, remote, target) {
    const source = remote.length > 1 ? remote.replace(/\/+$/, '') : remote;
    const kind = await this.remoteKind(serial, source);
    if (!kind) throw new AdbError(`기기에 없는 경로입니다: ${source}`);
    // -H follows a symlinked root such as /sdcard; stat gives the size to verify and the mtime to keep.
    const listing = await this.shellRaw(serial, `find -H ${shellQuote(source)} -type f -exec stat -c '%s|%Y|%n' {} +`);
    const files = lines(listing.stdout).map(line => /^(\d+)\|(\d+)\|(.+)$/.exec(line)).filter(Boolean)
      .map(([, size, mtime, name]) => ({ size: Number(size), mtime: Number(mtime), name }));
    if (kind === 'file') return this.pullFile(serial, source, target, files[0]);

    const prefix = source === '/' ? '/' : `${source}/`;
    const local = name => path.join(target, ...name.slice(prefix.length).split('/').filter(Boolean).map(localName));
    const dirs = lines((await this.shellRaw(serial, `find -H ${shellQuote(source)} -type d`)).stdout).filter(line => line.startsWith(prefix));
    fs.mkdirSync(target, { recursive: true });
    for (const dir of dirs) fs.mkdirSync(local(dir), { recursive: true });
    const queue = files.filter(file => file.name.startsWith(prefix)), failures = [];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        try { await this.pullFile(serial, file.name, local(file.name), file); }
        catch (error) { failures.push(`${file.name}: ${error.message}`); }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const denied = lines(listing.stderr.toString()).filter(line => line.trim());
    if (failures.length || denied.length) {
      throw new AdbError(`일부 항목을 받지 못했습니다 (${failures.length + denied.length}개).\n${[...failures, ...denied].slice(0, 5).join('\n')}`);
    }
  }

  async pullFile(serial, remote, target, meta) {
    const child = this.spawnProcess(this.bin(), ['-s', serial, 'exec-out', `cat ${shellQuote(remote)} 2>/dev/null`], { windowsHide: true });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const out = fs.createWriteStream(target);
    await pipeline(child.stdout, out);
    await exited;
    // exec-out reports neither stderr nor the exit code, so a size mismatch is re-checked for readability.
    if (meta && out.bytesWritten !== meta.size) {
      const check = await this.shellRaw(serial, `cat ${shellQuote(remote)} > /dev/null`);
      if (check.code !== 0) {
        fs.rmSync(target, { force: true });
        throw new AdbError(check.stderr.trim() || '파일을 읽을 수 없습니다.');
      }
    }
    if (meta?.mtime) fs.utimesSync(target, meta.mtime, meta.mtime);
  }

  async push(serial, locals, remoteDir) {
    for (const local of locals) await this.pushEntry(serial, local, joinRemote(remoteDir, path.basename(local)));
  }

  // `adb push dir existing-dir` would nest the folder under an adb-derived name, so existing folders are merged entry by entry.
  async pushEntry(serial, local, target) {
    if (fs.statSync(local).isDirectory() && await this.remoteKind(serial, target) === 'dir') {
      for (const child of fs.readdirSync(local)) await this.pushEntry(serial, path.join(local, child), joinRemote(target, child));
      return;
    }
    await this.exec(['-s', serial, 'push', local, target], { timeout: 0 });
  }

  remove(serial, remotes) {
    return this.shell(serial, `rm -rf ${remotes.map(shellQuote).join(' ')}`);
  }

  mkdir(serial, remote) {
    return this.shell(serial, `mkdir -p ${shellQuote(remote)}`);
  }

  move(serial, from, to) {
    return this.shell(serial, `mv ${shellQuote(from)} ${shellQuote(to)}`);
  }

  // Copies or moves items into destDir on the device. Copies never overwrite (a taken name becomes "… - 복사본"),
  // moves refuse a taken name. Returns how many items were actually transferred.
  async transfer(serial, sources, destDir, mode) {
    const trim = remote => (remote.length > 1 ? remote.replace(/\/+$/, '') : remote);
    const dest = trim(destDir);
    const taken = new Set((await this.list(serial, dest)).map(entry => entry.name));
    let done = 0;
    for (const source of sources.map(trim)) {
      const name = source.split('/').pop();
      if (dest === source || dest.startsWith(`${source}/`)) throw new AdbError(`폴더를 자기 자신 안으로 ${mode === 'move' ? '이동' : '복사'}할 수 없습니다: ${name}`);
      if (mode === 'move') {
        if (parentRemote(source) === dest) continue;
        if (taken.has(name)) throw new AdbError(`같은 이름의 항목이 이미 있습니다: ${name}`);
        await this.move(serial, source, joinRemote(dest, name));
        taken.add(name);
      } else {
        const target = uniqueName(taken, name);
        await this.shell(serial, `cp -r ${shellQuote(source)} ${shellQuote(joinRemote(dest, target))}`);
        taken.add(target);
      }
      done++;
    }
    return done;
  }

  async fileSize(serial, remote) {
    const size = Number((await this.shell(serial, `stat -L -c %s ${shellQuote(remote)}`)).trim());
    if (!Number.isFinite(size)) throw new AdbError(`파일 크기를 알 수 없습니다: ${remote}`);
    return size;
  }

  // Reads up to `bytes` leading bytes of each file in a single adb round trip; unreadable files come back empty.
  async readHeads(serial, remotes, bytes) {
    const script = remotes.map(remote => {
      const head = `head -c ${bytes} ${shellQuote(remote)} 2>/dev/null`;
      return `printf '@%s\\n' $(${head} | wc -c); ${head}`;
    }).join('; ');
    const { stdout } = await this.raw(['-s', serial, 'exec-out', script], { timeout: 60_000 });
    return parseHeads(stdout, remotes.length);
  }

  // MediaStore ids of every image on the device, used to find the thumbnails Android already generated.
  async mediaImageIds(serial) {
    return parseMediaIds(await this.shell(serial, 'content query --uri content://media/external/images/media --projection _id:_data', { timeout: 60_000 }));
  }

  // Streams bytes [start, start + length) of a device file for the preview protocol; the caller owns the child process.
  readRange(serial, remote, start, length) {
    const file = shellQuote(remote);
    const command = start > 0 ? `tail -c +${start + 1} ${file} | head -c ${length}` : `head -c ${length} ${file}`;
    return this.spawnProcess(this.bin(), ['-s', serial, 'exec-out', command], { windowsHide: true });
  }

  // Several byte ranges of one device file in a single adb call; every range must lie inside the file.
  async readRanges(serial, remote, ranges) {
    const file = shellQuote(remote);
    const script = ranges.map(([start, length]) => (start > 0 ? `tail -c +${start + 1} ${file} | head -c ${length}` : `head -c ${length} ${file}`)).join('; ');
    const { stdout, code } = await this.raw(['-s', serial, 'exec-out', script], { timeout: 60_000 });
    if (code !== 0) throw new AdbError(`파일을 읽을 수 없습니다: ${remote}`);
    let pos = 0;
    return ranges.map(([, length]) => { const part = stdout.subarray(pos, pos + length); pos += length; return part; });
  }

  // File size plus its last `bytes` bytes (a zip's directory lives there) in one adb call.
  async fileTail(serial, remote, bytes) {
    const file = shellQuote(remote);
    const { stdout, code } = await this.raw(['-s', serial, 'exec-out', `stat -L -c %s ${file}; tail -c ${bytes} ${file}`], { timeout: 60_000 });
    const newline = stdout.indexOf(0x0a), size = Number(stdout.toString('latin1', 0, Math.max(newline, 0)));
    if (code !== 0 || !Number.isFinite(size) || newline < 0) throw new AdbError(`파일을 읽을 수 없습니다: ${remote}`);
    return { size, tail: stdout.subarray(newline + 1) };
  }

  async packages(serial, kind = 'user') {
    const flag = { user: ' -3', system: ' -s', all: '' }[kind] ?? ' -3';
    const [all, disabled] = await Promise.all([
      this.shell(serial, `pm list packages -f${flag}`),
      this.shell(serial, `pm list packages -d${flag}`).catch(() => ''),
    ]);
    const off = new Set(parsePackages(disabled).map(item => item.name));
    const items = parsePackages(all);
    const stats = await this.apkStats(serial, items.map(item => item.apk).filter(Boolean));
    return items.map(item => ({ ...item, enabled: !off.has(item.name), size: stats.get(item.apk)?.size ?? null, modified: stats.get(item.apk)?.modified ?? null }));
  }

  // APK size and mtime (≈ install/update time; firstInstallTime is often bogus on system images) for many files in few calls.
  async apkStats(serial, files) {
    const stats = new Map();
    for (let i = 0; i < files.length; i += 100) {
      const batch = files.slice(i, i + 100).map(shellQuote).join(' ');
      const { stdout } = await this.shellRaw(serial, `stat -L -c '%s %Y %n' ${batch} 2>/dev/null; true`).catch(() => ({ stdout: '' }));
      for (const line of lines(stdout)) {
        const match = /^(\d+) (\d+) (.+)$/.exec(line);
        if (match) stats.set(match[3], { size: Number(match[1]), modified: Number(match[2]) * 1000 });
      }
    }
    return stats;
  }

  async packageInfo(serial, name) {
    // dumpsys prints hundreds of KB per package; keep only the lines parsePackageInfo reads.
    const keep = 'versionName=|versionCode=|targetSdk=|minSdk=|firstInstallTime=|lastUpdateTime=|installerPackageName=';
    return parsePackageInfo(await this.shell(serial, `dumpsys package ${shellQuote(assertPackage(name))} | grep -E '${keep}'`));
  }

  async install(serial, apk) {
    const out = await this.exec(['-s', serial, 'install', '-r', '-d', apk], { timeout: 10 * 60_000 });
    if (!/Success/.test(out)) throw new AdbError(out.trim() || '설치에 실패했습니다.');
    return out;
  }

  async uninstall(serial, name) {
    const out = await this.exec(['-s', serial, 'uninstall', assertPackage(name)], { timeout: 120_000 });
    if (!/Success/.test(out)) throw new AdbError(out.trim() || '제거에 실패했습니다.');
    return out;
  }

  async launch(serial, name) {
    const out = await this.shell(serial, `monkey -p ${shellQuote(assertPackage(name))} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|aborted/i.test(out)) throw new AdbError('실행할 수 있는 런처 액티비티가 없습니다.');
    return out;
  }

  forceStop(serial, name) {
    return this.shell(serial, `am force-stop ${shellQuote(assertPackage(name))}`);
  }

  async clearData(serial, name) {
    const out = await this.shell(serial, `pm clear ${shellQuote(assertPackage(name))}`);
    if (!/Success/.test(out)) throw new AdbError(out.trim() || '데이터 삭제에 실패했습니다.');
    return out;
  }

  setEnabled(serial, name, enabled) {
    return this.shell(serial, `pm ${enabled ? 'enable' : 'disable-user --user 0'} ${shellQuote(assertPackage(name))}`);
  }

  async screenshot(serial) {
    const { stdout, stderr, code } = await this.raw(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30_000 });
    const png = stdout.subarray(stdout.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    if (code !== 0 || png.length < 8 || png[0] !== 0x89) throw new AdbError(text(stderr).trim() || '스크린샷을 가져오지 못했습니다.');
    return png;
  }

  input(serial, kind, value) {
    return this.shell(serial, inputCommand(kind, value));
  }

  // What the live mirror needs: display size in the current orientation and whether `input motionevent` exists (Android 10+).
  async screenInfo(serial) {
    const read = async command => (await this.shell(serial, command).catch(() => '')).trim();
    const [size, rotation, sdk] = await Promise.all([read('wm size'), read('dumpsys input | grep -m1 SurfaceOrientation'), read('getprop ro.build.version.sdk')]);
    const display = displaySize(parseWmSize(size), parseRotation(rotation));
    if (!display) throw new AdbError('기기 화면 크기를 읽지 못했습니다.');
    return { ...display, motion: Number(sdk) >= 29 };
  }

  // Streams H.264 from `screenrecord` (hardware-encoded on the device, so the CPU cost stays low).
  // onFrame gets access units; onExit gets a message, or null when stopped on purpose. screenrecord caps a run at 180 s.
  mirror(serial, { width, height, bitrate = 4_000_000, onFrame, onExit }) {
    const args = ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--size', `${width}x${height}`, '--bit-rate', String(bitrate), '--time-limit', '180', '-'];
    const child = this.spawnProcess(this.bin(), args, { windowsHide: true });
    const splitter = new H264Splitter(onFrame);
    let stopped = false, stderr = '', head = '';
    // screenrecord reports some failures (e.g. screen off) as plain text on stdout instead of stderr.
    child.stdout.on('data', chunk => { if (!splitter.started) head = (head + chunk.toString('latin1')).slice(0, 400); splitter.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-400); });
    child.on('error', error => onExit?.(error.message));
    child.on('exit', code => onExit?.(stopped ? null : mirrorError(stderr.trim() || (/^ERROR/.test(head) ? head.trim() : ''), code)));
    return () => { stopped = true; child.kill(); };
  }

  // One long-lived `adb shell` that runs input commands one at a time. Spawning adb per touch is slow and loads the device;
  // here each command waits for the previous one's echo, so a burst of events can never pile up on the device.
  openInput(serial) {
    const child = this.spawnProcess(this.bin(), ['-s', serial, 'shell'], { windowsHide: true });
    const waiting = [];
    let closed = false;
    child.stdout.on('data', chunk => { for (let n = String(chunk).split('\n').length - 1; n > 0; n--) waiting.shift()?.(); });
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', () => { closed = true; for (const resolve of waiting.splice(0)) resolve(); });
    return {
      get busy() { return waiting.length > 0; },
      run(command) {
        if (closed) return Promise.reject(new AdbError('기기와의 입력 연결이 끊어졌습니다.'));
        return new Promise(resolve => { waiting.push(resolve); child.stdin.write(`${command} >/dev/null 2>&1; echo\n`); });
      },
      close() { closed = true; child.stdin.end('exit\n'); setTimeout(() => child.kill(), 500).unref?.(); },
    };
  }

  reboot(serial, mode) {
    return this.exec(['-s', serial, 'reboot', ...(mode ? [mode] : [])], { timeout: 30_000 });
  }

  async connect(address) {
    const out = await this.exec(['connect', address], { timeout: 20_000 });
    if (/failed|unable|cannot/i.test(out)) throw new AdbError(out.trim());
    return out.trim();
  }

  async pair(address, code) {
    const out = await this.exec(['pair', address, code], { timeout: 30_000 });
    if (!/Successfully paired/i.test(out)) throw new AdbError(out.trim() || '페어링에 실패했습니다.');
    return out.trim();
  }

  async mdnsServices() {
    return parseMdnsServices(await this.exec(['mdns', 'services'], { timeout: 10_000 }));
  }

  // The phone scans the QR code and then advertises a pairing service named `name`; pair with it using `password`,
  // then connect to the device's _adb-tls-connect service on the same IP.
  async pairWithQr(name, password, { signal, timeout = 120_000, interval = 1000 } = {}) {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const until = async (find, limit) => {
      const deadline = Date.now() + limit;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new AdbError('QR 페어링이 취소되었습니다.');
        const found = await find().catch(() => null);
        if (found) return found;
        await sleep(interval);
      }
      return null;
    };
    const pairing = await until(async () => (await this.mdnsServices()).find(item => item.type === '_adb-tls-pairing._tcp' && item.name === name), timeout);
    if (!pairing) throw new AdbError('시간 안에 QR 코드가 스캔되지 않았습니다. 기기와 PC가 같은 Wi-Fi에 있는지 확인하세요.');
    await this.pair(pairing.address, password);
    const host = pairing.address.slice(0, pairing.address.lastIndexOf(':'));
    const target = await until(async () => (await this.mdnsServices()).find(item => item.type === '_adb-tls-connect._tcp' && item.address.startsWith(`${host}:`)), 15_000);
    if (!target) return { paired: true, address: null };
    await this.connect(target.address);
    return { paired: true, address: target.address };
  }

  disconnect(serial) {
    return this.exec(['disconnect', serial]);
  }

  // Switches a USB device to TCP mode, then connects to it over Wi-Fi.
  async enableWireless(serial, port = 5555) {
    const ip = parseIpv4(await this.shell(serial, 'ip -f inet addr show wlan0').catch(() => ''));
    if (!ip) throw new AdbError('기기의 Wi-Fi IP 주소를 찾지 못했습니다. 기기가 PC와 같은 Wi-Fi에 연결되어 있는지 확인하세요.');
    await this.exec(['-s', serial, 'tcpip', String(port)]);
    const address = `${ip}:${port}`;
    let last;
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try { await this.connect(address); return address; } catch (error) { last = error; }
    }
    throw last;
  }

  async restartServer() {
    await this.exec(['kill-server']).catch(() => {});
    await this.exec(['start-server']);
  }

  // Streams `logcat -v threadtime`; returns a function that stops it.
  logcat(serial, { tail = 500, onLine, onExit }) {
    const child = this.spawnProcess(this.bin(), ['-s', serial, 'logcat', '-v', 'threadtime', '-T', String(tail)], { windowsHide: true });
    let buffer = '', stopped = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const part of parts) if (part.trim()) onLine(parseLogcatLine(part.replace(/\r$/, '')));
    });
    child.on('error', error => onExit?.(error.message));
    child.on('exit', code => onExit?.(stopped ? null : `logcat이 종료되었습니다 (exit ${code}).`));
    return () => { stopped = true; child.kill(); };
  }

  clearLogcat(serial) {
    return this.exec(['-s', serial, 'logcat', '-c']);
  }
}
