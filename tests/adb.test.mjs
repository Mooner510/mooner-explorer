import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  Adb, AdbError, assertPackage, joinRemote, localName, parentRemote, parseBattery, parseCpuRange, parseCpuStat, splitSections, parseDevices, parseDf, parseMdnsServices, parseMeminfo, parseGetprop, parseIpv4, wifiPairingPayload,
  H264Splitter, displaySize, mirrorError, inputCommand, parseRotation, streamSize, parseLogcatLine, parseLs, parsePackageInfo, parsePackages, parseWmDensity, parseWmSize, shellQuote, uniqueName,
} from '../src/adb.js';

test('shellQuote escapes single quotes for sh', () => {
  assert.equal(shellQuote('/sdcard/My Files'), `'/sdcard/My Files'`);
  assert.equal(shellQuote(`it's; rm -rf /`), `'it'\\''s; rm -rf /'`);
});

test('remote path helpers', () => {
  assert.equal(joinRemote('/', 'sdcard'), '/sdcard');
  assert.equal(joinRemote('/sdcard', 'a b'), '/sdcard/a b');
  assert.equal(parentRemote('/sdcard/Download'), '/sdcard');
  assert.equal(parentRemote('/sdcard/'), '/');
  assert.equal(parentRemote('/'), '/');
});

test('assertPackage rejects shell metacharacters', () => {
  assert.equal(assertPackage('com.example.app_1'), 'com.example.app_1');
  assert.throws(() => assertPackage('com.x; reboot'), AdbError);
  assert.throws(() => assertPackage(''), AdbError);
});

test('parseDevices handles usb, wireless, unauthorized and no permissions', () => {
  const devices = parseDevices([
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'R5CT1234ABC            device usb:1-1 product:o1sxx model:SM_G991N device:o1s transport_id:3',
    '192.168.0.12:5555      device product:husky model:Pixel_8_Pro device:husky transport_id:5',
    'adb-28131FDH2000AB-xyz._adb-tls-connect._tcp device product:p model:Pixel_7 device:panther transport_id:6',
    'ZY22ABCDEF             unauthorized usb:1-2 transport_id:4',
    '0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-3 transport_id:7',
    '',
  ].join('\r\n'));
  assert.equal(devices.length, 5);
  assert.deepEqual(devices[0], { serial: 'R5CT1234ABC', state: 'device', model: 'SM G991N', product: 'o1sxx', device: 'o1s', transportId: '3', wireless: false });
  assert.equal(devices[1].wireless, true);
  assert.equal(devices[1].model, 'Pixel 8 Pro');
  assert.equal(devices[2].wireless, true);
  assert.equal(devices[3].state, 'unauthorized');
  assert.equal(devices[3].model, null);
  assert.equal(devices[4].state, 'no permissions');
  assert.equal(devices[4].transportId, '7');
});

test('parseGetprop', () => {
  const props = parseGetprop('[ro.product.model]: [Pixel 8]\n[ro.build.version.release]: [15]\n[empty]: []\n');
  assert.deepEqual(props, { 'ro.product.model': 'Pixel 8', 'ro.build.version.release': '15', empty: '' });
});

test('parseBattery', () => {
  const battery = parseBattery(`Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  status: 2
  health: 2
  present: true
  level: 87
  scale: 100
  voltage: 4312
  temperature: 301
  technology: Li-ion`);
  assert.deepEqual(battery, { level: 87, scale: 100, status: '충전 중', temperature: 30.1, voltage: 4.312, health: '2', powered: ['USB'] });
  assert.equal(parseBattery(''), null);
});

test('parseDf handles single and wrapped lines', () => {
  assert.deepEqual(parseDf('Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-48 113805200 40000000 73805200  36% /data\n'),
    { total: 113805200 * 1024, used: 40000000 * 1024, free: 73805200 * 1024 });
  assert.deepEqual(parseDf('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/bootdevice/by-name/userdata\n 1000 400 600 40% /data\n'),
    { total: 1024000, used: 409600, free: 614400 });
  assert.equal(parseDf('df: /data: Permission denied'), null);
});

test('wm and ip parsers', () => {
  assert.equal(parseWmSize('Physical size: 1080x2400\n'), '1080x2400');
  assert.equal(parseWmSize('Physical size: 1440x3120\nOverride size: 1080x2340\n'), '1080x2340');
  assert.equal(parseWmDensity('Physical density: 420\n'), '420');
  assert.equal(parseIpv4('30: wlan0: <BROADCAST,MULTICAST,UP> mtu 1500\n    inet 192.168.0.23/24 brd 192.168.0.255 scope global wlan0\n'), '192.168.0.23');
  assert.equal(parseIpv4('Device "wlan0" does not exist.'), null);
});

test('parseLs parses toybox output including spaces, links and devices', () => {
  const entries = parseLs([
    'total 128',
    'drwxrwx--x  6 root sdcard_rw 3488 2024-05-01 10:22 .',
    'drwx--x--x  4 root sdcard_rw 3488 2024-01-01 09:00 ..',
    '-rw-rw----  1 u0_a123 media_rw 1048576 2024-05-02 11:05 my photo.jpg',
    'drwxrws---  2 u0_a123 media_rw 3452 2024-05-03 08:00 Download',
    'lrw-r--r--  1 root root 21 2009-01-01 09:00 sdcard -> /storage/self/primary',
    'crw-rw-rw-  1 root root 1,   3 2024-05-01 10:00 null',
    '-rw-r--r--  1 root root 0 2024-05-01 10:00:59.123456789 precise',
    'ls: ./secret: Permission denied',
  ].join('\n'));
  assert.deepEqual(entries.map(entry => [entry.name, entry.type]), [
    ['Download', 'dir'], ['sdcard', 'link'], ['my photo.jpg', 'file'], ['null', 'other'], ['precise', 'file'],
  ]);
  const photo = entries.find(entry => entry.name === 'my photo.jpg');
  assert.equal(photo.size, 1048576);
  assert.equal(photo.modified, '2024-05-02 11:05');
  assert.equal(entries.find(entry => entry.name === 'sdcard').target, '/storage/self/primary');
  assert.equal(entries.find(entry => entry.name === 'null').size, null);
  assert.equal(entries.find(entry => entry.name === 'precise').modified, '2024-05-01 10:00');
});

test('parsePackages keeps apk paths containing =', () => {
  const packages = parsePackages('package:/data/app/~~AbC==/com.foo-XyZ==/base.apk=com.foo\npackage:/system/app/Bar/Bar.apk=com.bar\npackage:com.plain\n');
  assert.deepEqual(packages, [
    { name: 'com.bar', apk: '/system/app/Bar/Bar.apk' },
    { name: 'com.foo', apk: '/data/app/~~AbC==/com.foo-XyZ==/base.apk' },
    { name: 'com.plain', apk: null },
  ]);
});

test('parsePackageInfo', () => {
  const info = parsePackageInfo(`Packages:
  Package [com.foo] (abc):
    versionCode=42 minSdk=24 targetSdk=34
    versionName=1.2.3
    installerPackageName=com.android.vending
    firstInstallTime=2024-01-02 03:04:05
    lastUpdateTime=2024-02-03 04:05:06`);
  assert.equal(info.versionName, '1.2.3');
  assert.equal(info.versionCode, '42');
  assert.equal(info.targetSdk, '34');
  assert.equal(info.minSdk, '24');
  assert.equal(info.installer, 'com.android.vending');
  assert.equal(info.lastUpdateTime, '2024-02-03 04:05:06');
});

test('parseLogcatLine', () => {
  assert.deepEqual(parseLogcatLine('10-21 12:34:56.789  1234  5678 E ActivityManager: ANR in com.foo: reason'), {
    time: '10-21 12:34:56.789', pid: '1234', tid: '5678', level: 'E', tag: 'ActivityManager', message: 'ANR in com.foo: reason',
  });
  assert.equal(parseLogcatLine('--------- beginning of main').message, '--------- beginning of main');
});

function fakeRun(responses) {
  const calls = [];
  const run = async (file, args) => {
    calls.push(args);
    const key = args.join(' ');
    const match = responses.find(([pattern]) => (pattern instanceof RegExp ? pattern.test(key) : key === pattern));
    const [, stdout = '', stderr = '', code = 0] = match ?? [];
    return { stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: Buffer.from(stderr), code };
  };
  return { run, calls };
}

test('Adb.list quotes the path and lists symlinked dirs via trailing slash', async () => {
  const { run, calls } = fakeRun([[/ls -la/, 'drwxrwx--x 2 root root 3488 2024-05-01 10:22 Music\n']]);
  const adb = new Adb({ binary: 'adb', run });
  const entries = await adb.list('SER', "/sdcard/it's");
  assert.deepEqual(calls[0], ['-s', 'SER', 'shell', `ls -la '/sdcard/it'\\''s/'`]);
  assert.equal(entries[0].name, 'Music');
});

test('Adb.list surfaces permission errors', async () => {
  const { run } = fakeRun([[/ls -la/, '', 'ls: /data/: Permission denied', 1]]);
  await assert.rejects(new Adb({ binary: 'adb', run }).list('SER', '/data'), /Permission denied/);
});

test('Adb reports a missing binary clearly', async () => {
  await assert.rejects(new Adb({ binary: () => null }).devices(), /adb를 찾을 수 없습니다/);
});

test('Adb.install requires Success in output', async () => {
  const ok = fakeRun([[/install/, 'Performing Streamed Install\nSuccess\n']]);
  await new Adb({ binary: 'adb', run: ok.run }).install('SER', 'C:/a.apk');
  assert.deepEqual(ok.calls[0], ['-s', 'SER', 'install', '-r', '-d', 'C:/a.apk']);
  const bad = fakeRun([[/install/, 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE]\n']]);
  await assert.rejects(new Adb({ binary: 'adb', run: bad.run }).install('SER', 'a.apk'), /INSTALL_FAILED/);
});

test('Adb.screenshot strips leading noise before the PNG signature', async () => {
  const png = Buffer.concat([Buffer.from('WARNING: noise\n'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])]);
  const { run } = fakeRun([[/screencap/, png]]);
  const result = await new Adb({ binary: 'adb', run }).screenshot('SER');
  assert.equal(result[0], 0x89);
  assert.equal(result.length, 11);
});

test('Adb.packages marks disabled packages', async () => {
  const { run } = fakeRun([
    ['-s SER shell pm list packages -f -3', 'package:/data/app/a/base.apk=com.a\npackage:/data/app/b/base.apk=com.b\n'],
    ['-s SER shell pm list packages -d -3', 'package:com.b\n'],
  ]);
  const packages = await new Adb({ binary: 'adb', run }).packages('SER', 'user');
  assert.deepEqual(packages.map(item => [item.name, item.enabled]), [['com.a', true], ['com.b', false]]);
});

test('Adb.input escapes text and rounds coordinates', async () => {
  const { run, calls } = fakeRun([]);
  const adb = new Adb({ binary: 'adb', run });
  await adb.input('SER', 'text', "hi there's");
  await adb.input('SER', 'tap', { x: 10.6, y: 20.2 });
  assert.equal(calls[0][3], `input text 'hi%sthere'\\''s'`);
  assert.equal(calls[1][3], 'input tap 11 20');
});

test('Adb.logcat parses streamed lines across chunk boundaries', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => child.emit('exit', null);
  const lines = [];
  let exit;
  const stop = new Adb({ binary: 'adb', spawnProcess: () => child }).logcat('SER', { onLine: line => lines.push(line), onExit: message => { exit = message; } });
  child.stdout.write('10-21 12:00:00.000  1  2 I Tag: hel');
  child.stdout.write('lo\r\n10-21 12:00:00.001  1  2 W Other: x\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lines.map(line => [line.tag, line.message]), [['Tag', 'hello'], ['Other', 'x']]);
  stop();
  assert.equal(exit, null);
});

test('localName takes the last segment and keeps Korean names', () => {
  assert.equal(localName('/sdcard/한글 폴더/'), '한글 폴더');
  assert.equal(localName('/'), 'root');
  if (process.platform === 'win32') assert.equal(localName('/sdcard/a:b?.txt'), 'a_b_.txt');
});

test('Adb.push names targets explicitly and merges into existing folders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mooner-explorer-test-'));
  try {
    fs.mkdirSync(path.join(dir, '한글폴더', '하위'), { recursive: true });
    fs.writeFileSync(path.join(dir, '한글폴더', '하위', '파일.txt'), 'x');
    fs.writeFileSync(path.join(dir, '한글폴더', 'a.txt'), 'y');
    // The first folder level already exists on the device, the nested one does not.
    const { run, calls } = fakeRun([[/\[ -d '\/sdcard\/한글폴더' \]/, 'dir\n'], [/\[ -d /, '']]);
    await new Adb({ binary: 'adb', run }).push('SER', [path.join(dir, '한글폴더')], '/sdcard');
    const pushes = calls.filter(args => args[2] === 'push').map(args => args.slice(3));
    assert.deepEqual(pushes, [
      [path.join(dir, '한글폴더', 'a.txt'), '/sdcard/한글폴더/a.txt'],
      [path.join(dir, '한글폴더', '하위'), '/sdcard/한글폴더/하위'],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Adb.pull streams files through exec-out and recreates Korean folders locally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mooner-explorer-test-'));
  const contents = { '/sdcard/사진/a.jpg': 'AAAA', '/sdcard/사진/하위/b.txt': 'bb' };
  const { run } = fakeRun([
    [/\[ -d /, 'dir\n'],
    [/-type f -exec stat/, '4|1700000000|/sdcard/사진/a.jpg\n2|1700000000|/sdcard/사진/하위/b.txt\n'],
    [/-type d/, '/sdcard/사진\n/sdcard/사진/하위\n'],
  ]);
  const spawnProcess = (_bin, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    const remote = /^cat '(.*)' 2>\/dev\/null$/.exec(args[3])[1];
    setImmediate(() => { child.stdout.end(contents[remote]); setImmediate(() => child.emit('close', 0)); });
    return child;
  };
  try {
    const [target] = await new Adb({ binary: 'adb', run, spawnProcess }).pull('SER', ['/sdcard/사진/'], dir);
    assert.equal(target, path.join(dir, '사진'));
    assert.equal(fs.readFileSync(path.join(target, 'a.jpg'), 'utf8'), 'AAAA');
    assert.equal(fs.readFileSync(path.join(target, '하위', 'b.txt'), 'utf8'), 'bb');
    assert.equal(fs.statSync(path.join(target, 'a.jpg')).mtimeMs, 1700000000 * 1000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseMeminfo reads kB values and falls back without MemAvailable', () => {
  assert.deepEqual(parseMeminfo('MemTotal:       8000 kB\nMemFree:        1000 kB\nMemAvailable:   3000 kB\nCached:         500 kB\n'),
    { total: 8000 * 1024, available: 3000 * 1024, used: 5000 * 1024 });
  assert.deepEqual(parseMeminfo('MemTotal: 8000 kB\nMemFree: 1000 kB\nCached: 500 kB\n'),
    { total: 8000 * 1024, available: 1500 * 1024, used: 6500 * 1024 });
  assert.equal(parseMeminfo('cat: /proc/meminfo: Permission denied'), null);
});

test('parseCpuStat sums busy and idle jiffies', () => {
  assert.deepEqual(parseCpuStat('cpu  100 0 50 800 50 0 0 0 0 0\n'), { idle: 850, total: 1000 });
  assert.equal(parseCpuStat('head: /proc/stat: Permission denied'), null);
});

test('parseMdnsServices reads pairing and connect services', () => {
  const out = 'List of discovered mdns services\nmooner-123456\t_adb-tls-pairing._tcp\t192.168.0.5:41234\nadb-ABC\t_adb-tls-connect._tcp\t192.168.0.5:37001\n';
  assert.deepEqual(parseMdnsServices(out), [
    { name: 'mooner-123456', type: '_adb-tls-pairing._tcp', address: '192.168.0.5:41234' },
    { name: 'adb-ABC', type: '_adb-tls-connect._tcp', address: '192.168.0.5:37001' },
  ]);
  assert.equal(wifiPairingPayload('mooner-1', '654321'), 'WIFI:T:ADB;S:mooner-1;P:654321;;');
});

test('pairWithQr pairs with the matching service and connects', async () => {
  const calls = [];
  const run = async (_bin, args) => {
    calls.push(args.join(' '));
    const out = args[0] === 'mdns'
      ? 'other\t_adb-tls-pairing._tcp\t10.0.0.9:1111\nmooner-1\t_adb-tls-pairing._tcp\t192.168.0.5:41234\nadb-X\t_adb-tls-connect._tcp\t192.168.0.5:37001\n'
      : args[0] === 'pair' ? 'Successfully paired to 192.168.0.5:41234' : 'connected to 192.168.0.5:37001';
    return { stdout: Buffer.from(out), stderr: Buffer.alloc(0), code: 0 };
  };
  const result = await new Adb({ binary: 'adb', run }).pairWithQr('mooner-1', '654321', { interval: 1 });
  assert.deepEqual(result, { paired: true, address: '192.168.0.5:37001' });
  assert.ok(calls.includes('pair 192.168.0.5:41234 654321'));
  assert.ok(calls.includes('connect 192.168.0.5:37001'));
});

test('uniqueName appends 복사본 before the extension', () => {
  assert.equal(uniqueName(new Set(['b.txt']), 'a.txt'), 'a.txt');
  assert.equal(uniqueName(new Set(['a.txt']), 'a.txt'), 'a - 복사본.txt');
  assert.equal(uniqueName(new Set(['a.txt', 'a - 복사본.txt']), 'a.txt'), 'a - 복사본 (2).txt');
  assert.equal(uniqueName(new Set(['dir']), 'dir'), 'dir - 복사본');
  assert.equal(uniqueName(new Set(['.hidden']), '.hidden'), '.hidden - 복사본');
});

test('Adb.transfer copies with unique names and moves without overwriting', async () => {
  const listing = 'drwxrwx--x 2 root root 3488 2024-05-01 10:22 Music\n-rw-rw---- 1 root root 5 2024-05-01 10:22 a.txt\n';
  const { run, calls } = fakeRun([[/ls -la '\/sdcard\/Dest\/'/, listing]]);
  const adb = new Adb({ binary: 'adb', run });
  assert.equal(await adb.transfer('SER', ['/sdcard/a.txt', '/sdcard/b.txt'], '/sdcard/Dest/', 'copy'), 2);
  const shells = calls.filter(args => args[2] === 'shell' && !args[3].startsWith('ls')).map(args => args[3]);
  assert.deepEqual(shells, [`cp -r '/sdcard/a.txt' '/sdcard/Dest/a - 복사본.txt'`, `cp -r '/sdcard/b.txt' '/sdcard/Dest/b.txt'`]);

  await assert.rejects(adb.transfer('SER', ['/sdcard/x/a.txt'], '/sdcard/Dest', 'move'), /같은 이름의 항목이 이미 있습니다: a\.txt/);
  assert.equal(await adb.transfer('SER', ['/sdcard/Dest/new.txt'], '/sdcard/Dest', 'move'), 0);
  assert.equal(await adb.transfer('SER', ['/sdcard/z.txt'], '/sdcard/Dest', 'move'), 1);
  assert.equal(calls.at(-1)[3], `mv '/sdcard/z.txt' '/sdcard/Dest/z.txt'`);
  await assert.rejects(adb.transfer('SER', ['/sdcard/Dest'], '/sdcard/Dest/Music', 'copy'), /자기 자신 안으로/);
});

test('Adb.fileSize and readRange build device commands', async () => {
  const { run, calls } = fakeRun([[/stat -L/, '12345\n']]);
  const spawned = [];
  const adb = new Adb({ binary: 'adb', run, spawnProcess: (_bin, args) => { spawned.push(args); return {}; } });
  assert.equal(await adb.fileSize('SER', "/sdcard/it's.mp3"), 12345);
  assert.deepEqual(calls[0], ['-s', 'SER', 'shell', `stat -L -c %s '/sdcard/it'\\''s.mp3'`]);
  adb.readRange('SER', '/sdcard/a.mp4', 0, 100);
  adb.readRange('SER', '/sdcard/a.mp4', 50, 100);
  assert.deepEqual(spawned.map(args => args[3]), [`head -c 100 '/sdcard/a.mp4'`, `tail -c +51 '/sdcard/a.mp4' | head -c 100`]);
});

test('displaySize swaps axes when rotated', () => {
  assert.deepEqual(displaySize('1080x2400', 0), { width: 1080, height: 2400 });
  assert.deepEqual(displaySize('1080x2400', 1), { width: 2400, height: 1080 });
  assert.equal(displaySize(null), null);
});

test('parseRotation reads dumpsys input and wm output', () => {
  assert.equal(parseRotation('  SurfaceOrientation: 1'), 1);
  assert.equal(parseRotation('mCurrentRotation=ROTATION_270'), 3);
  assert.equal(parseRotation(''), 0);
});

test('streamSize caps the long side in multiples of 16 and never upscales', () => {
  assert.deepEqual(streamSize({ width: 1080, height: 2400 }, 1280), { width: 576, height: 1280 });
  assert.deepEqual(streamSize({ width: 720, height: 1280 }, 1920), { width: 720, height: 1280 });
});

test('inputCommand builds and clamps input commands', () => {
  assert.equal(inputCommand('tap', { x: 10.4, y: 20.6 }), 'input tap 10 21');
  assert.equal(inputCommand('down', { x: 5000, y: -3 }, { width: 1080, height: 2400 }), 'input motionevent DOWN 1079 0');
  assert.equal(inputCommand('swipe', { x1: 1, y1: 2, x2: 3, y2: 4, duration: 250 }), 'input swipe 1 2 3 4 250');
  assert.equal(inputCommand('text', 'a b'), "input text 'a%sb'");
  assert.throws(() => inputCommand('format', {}), AdbError);
});

test('H264Splitter groups SPS/PPS with the next slice and handles split chunks', () => {
  const frames = [];
  const splitter = new H264Splitter(frame => frames.push(frame));
  const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac]);
  const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xee, 0x3c]);
  const idr = Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
  const delta = Buffer.from([0, 0, 1, 0x41, 4, 5]);
  const stream = Buffer.concat([sps, pps, idr, delta, Buffer.from([0, 0, 0, 1, 0x41, 9])]);
  splitter.push(stream.subarray(0, 11));
  splitter.push(stream.subarray(11));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].key, true);
  assert.equal(frames[0].codec, 'avc1.64001f');
  assert.deepEqual([...frames[0].data], [...sps, ...pps, ...idr]);
  assert.equal(frames[1].key, false);
  assert.deepEqual([...frames[1].data], [...delta]);
});

test('mirrorError explains a sleeping display', () => {
  assert.match(mirrorError('ERROR: UNASSIGNED_LAYER_STACK, plug', 1), /꺼져 있습니다/);
  assert.match(mirrorError('', 1), /exit 1/);
});

test('parseCpuRange counts cores in /sys cpu ranges', () => {
  assert.equal(parseCpuRange('0-7\n'), 8);
  assert.equal(parseCpuRange('0-3,6-7'), 6);
  assert.equal(parseCpuRange('0'), 1);
  assert.equal(parseCpuRange(''), null);
  assert.equal(parseCpuRange('cat: Permission denied'), null);
});

test('splitSections separates batched shell output', () => {
  const mark = '__MOONER_SECTION__';
  assert.deepEqual(splitSections(`a\nb\n\n${mark}\n\n${mark}\nno-newline\n${mark}\n`, 3), ['a\nb', '', 'no-newline']);
  assert.deepEqual(splitSections(`x\n\n${mark}\n`, 2), ['x', '']);
});

test('shellBatch runs every command in one adb shell', async () => {
  const calls = [];
  const adb = new Adb({ binary: 'adb', run: async (_file, args) => {
    calls.push(args);
    return { stdout: Buffer.from('one\n\n__MOONER_SECTION__\ntwo\n__MOONER_SECTION__\n'), stderr: Buffer.alloc(0), code: 0 };
  } });
  assert.deepEqual(await adb.shellBatch('SER', ['echo one', 'printf two']), ['one', 'two']);
  assert.equal(calls.length, 1);
  assert.match(calls[0][3], /\(echo one\) 2>\/dev\/null; echo; echo __MOONER_SECTION__\n\(printf two\)/);
});
