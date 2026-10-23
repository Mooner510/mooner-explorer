import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';

assert.equal(process.platform, 'win32', 'Windows에서만 패키징할 수 있습니다');

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const bundle = path.join(root, 'dist', `${pkg.productName}-win32-${process.arch}`);
const exe = path.join(bundle, `${pkg.productName}.exe`);
const app = path.join(bundle, 'resources', 'app');

// Electron 배포본을 그대로 복사하고, 실행 파일 이름만 앱 이름으로 바꾼다.
rmSync(bundle, { recursive: true, force: true });
cpSync(path.dirname(require('electron')), bundle, { recursive: true });
renameSync(path.join(bundle, 'electron.exe'), exe);
brandExe(exe);
// 배포한 exe가 ELECTRON_RUN_AS_NODE·NODE_OPTIONS·--inspect로 임의 Node 코드를 실행하는 통로가 되지 않게 막는다.
await flipFuses(exe, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
});

// resources/app 이 있으면 Electron이 기본 앱 대신 이 폴더를 실행한다.
mkdirSync(app, { recursive: true });
for (const dir of ['src', 'assets']) cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
cpSync(path.join(root, 'LICENSE'), path.join(app, 'LICENSE'));
const { name, productName, version, description, type, main, dependencies = {} } = pkg;
writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name, productName, version, description, type, main, dependencies }, null, 2));
// 런타임 의존성은 하위 의존성이 없는 패키지만 쓰므로, pnpm 심볼릭 링크를 따라가 실제 폴더만 복사한다.
for (const dependency of Object.keys(dependencies)) {
  const source = realpathSync(path.join(root, 'node_modules', dependency));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8')).dependencies ?? {}), [], `${dependency}의 하위 의존성은 복사하지 않습니다`);
  cpSync(source, path.join(app, 'node_modules', dependency), { recursive: true, dereference: true });
}

assert.ok(existsSync(exe));
assert.ok(existsSync(path.join(app, main)));
console.log(`패키징 완료: ${bundle}`);

// 탐색기에 보이는 exe 아이콘과 이름은 창 아이콘이 아니라 exe 리소스에서 읽는다.
// Electron은 아이콘 그룹을 id 1, 버전 문자열을 en-US(1033)에 둔다.
function brandExe(file) {
  const binary = ResEdit.NtExecutable.from(readFileSync(file), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(binary);
  const ico = ResEdit.Data.IconFile.from(readFileSync(path.join(root, 'assets', 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, ico.icons.map(item => item.data));
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    CompanyName: 'Mooner', FileDescription: pkg.productName, ProductName: pkg.productName, FileVersion: pkg.version, ProductVersion: pkg.version,
    InternalName: `${pkg.productName}.exe`, OriginalFilename: `${pkg.productName}.exe`, LegalCopyright: ''
  });
  info.removeStringValue({ lang: 1033, codepage: 1200 }, 'SquirrelAwareVersion');
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  info.setFileVersion(major, minor, patch, 0, 1033);
  info.setProductVersion(major, minor, patch, 0, 1033);
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(binary);
  writeFileSync(file, Buffer.from(binary.generate()));
}
