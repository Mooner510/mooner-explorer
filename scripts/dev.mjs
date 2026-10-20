import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = fileURLToPath(new URL('..', import.meta.url));

// 메인 프로세스가 이 코드로 종료하면 같은 터미널에 붙은 채로 다시 실행한다.
const RESTART_CODE = 75;

let child;
let stopping = false;

function launch() {
  child = spawn(electron, [root, '--dev'], { stdio: 'inherit', windowsHide: false });
  child.once('error', error => { console.error(error); process.exit(1); });
  child.once('exit', code => {
    if (!stopping && code === RESTART_CODE) launch();
    else process.exit(code ?? 1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
launch();
