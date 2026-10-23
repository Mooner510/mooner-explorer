import { app, dialog } from 'electron';
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

const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
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

export async function checkForUpdate({ repo, asset, window }) {
  if (!portable()) return;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': app.getName() };
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!response.ok) return;
  const release = await response.json();
  const version = String(release.tag_name).replace(/^v/, '');
  const file = release.assets?.find(item => item.name === asset);
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, app.getVersion()) || !file) return;
  const prompt = {
    type: 'info', buttons: ['업데이트 후 재시작', '나중에'], defaultId: 0, cancelId: 1, title: '업데이트',
    message: `새 버전 ${version}을 사용할 수 있습니다.`,
    detail: `현재 버전은 ${app.getVersion()}입니다. 업데이트를 받은 뒤 앱이 잠시 종료되었다가 다시 실행됩니다.`,
  };
  const { response: choice } = await (window ? dialog.showMessageBox(window, prompt) : dialog.showMessageBox(prompt));
  if (choice !== 0) return;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mooner-update-'));
  try {
    const zip = path.join(work, asset);
    const download = await fetch(file.browser_download_url, { headers: { 'User-Agent': app.getName() } });
    if (!download.ok) throw new Error(`다운로드 실패 (HTTP ${download.status})`);
    const hash = createHash('sha256');
    await pipeline(Readable.fromWeb(download.body), async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk; } }, fs.createWriteStream(zip));
    // GitHub는 올린 파일마다 sha256 다이제스트를 기록한다. 일치하지 않으면 적용하지 않는다.
    if (file.digest !== `sha256:${hash.digest('hex')}`) throw new Error('받은 업데이트 파일의 해시가 릴리스와 다릅니다.');
    const extracted = path.join(work, 'new');
    fs.mkdirSync(extracted);
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', extracted]);
    fs.rmSync(zip);
    const [folder] = fs.readdirSync(extracted);
    const source = path.join(extracted, folder ?? '');
    if (!folder || !fs.existsSync(path.join(source, path.basename(process.execPath)))) throw new Error('업데이트 파일 구성이 올바르지 않습니다.');
    const script = path.join(work, 'apply.ps1');
    fs.writeFileSync(script, APPLY);
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, String(process.pid), source, path.dirname(process.execPath), process.execPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    dialog.showErrorBox('업데이트', `업데이트하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}
