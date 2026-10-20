// assets/icon.svg → assets/icon.png(512) + assets/icon.ico. Electron 렌더러의 canvas로 래스터화하므로 추가 의존성이 없다.
// 실행: pnpm exec electron scripts/build-icon.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'assets');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function rasterize(win, svg, sizes) {
  const script = `(async () => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    await img.decode();
    return ${JSON.stringify(sizes)}.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    });
  })()`;
  const out = await win.webContents.executeJavaScript(script);
  return out.map(b64 => Buffer.from(b64, 'base64'));
}

// PNG를 그대로 담는 ICO(Vista 이상). 헤더 6 + 엔트리 16*n 뒤에 이미지 데이터가 이어진다.
function buildIco(pngs, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map((png, i) => {
    const e = Buffer.alloc(16);
    const s = sizes[i];
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

// ESM 진입 파일은 평가가 끝나야 ready가 발생하므로 top-level await 대신 콜백으로 이어간다.
async function main() {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const svg = await fs.readFile(path.join(root, 'icon.svg'), 'utf8');
  const [png512] = await rasterize(win, svg, [512]);
  const icoPngs = await rasterize(win, svg, ICO_SIZES);
  await fs.writeFile(path.join(root, 'icon.png'), png512);
  await fs.writeFile(path.join(root, 'icon.ico'), buildIco(icoPngs, ICO_SIZES));
  console.log('assets/icon.png, assets/icon.ico 생성 완료');
}

app.whenReady().then(main).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app.quit());
