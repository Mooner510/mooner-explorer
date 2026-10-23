// 포터블 Windows 앱을 빌드해 zip으로 묶고, 앱의 자동 업데이트가 읽는 GitHub 릴리스로 올린다.
// 먼저 package.json의 version을 올린다. 릴리스 태그는 v<version>이다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'zip에 Windows 빌드가 들어가므로 Windows에서 릴리스한다');
const root = fileURLToPath(new URL('..', import.meta.url));
const { version, productName } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
// GitHub는 파일 이름의 공백을 점으로 바꾸므로 zip 이름에는 공백 없는 이름을 쓴다.
const zip = path.join(dist, `mooner-explorer-win32-${process.arch}.zip`);

execFileSync('pnpm', ['package'], { cwd: root, stdio: 'inherit', shell: true });
rmSync(zip, { force: true });
execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dist, `${productName}-win32-${process.arch}`], { stdio: 'inherit' });
execFileSync('gh', ['release', 'create', `v${version}`, zip, '--repo', 'Mooner510/mooner-explorer', '--title', `v${version}`, '--generate-notes'], { cwd: root, stdio: 'inherit' });
