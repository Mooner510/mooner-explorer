import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';

// HEIC/HEIF 디코딩(WASM)은 오래 걸릴 수 있어 UI가 멈추지 않도록 워커 스레드에서 한다.
const libheif = createRequire(import.meta.url)('libheif-js/wasm-bundle');
const decoder = new libheif.HeifDecoder();

// HEIC 한 장을 읽어 { width, height, bgra }로 돌려준다. (Electron nativeImage.createFromBitmap이 BGRA를 받는다)
function decode(bytes) {
  const [image] = decoder.decode(bytes);
  if (!image) throw new Error('HEIC 이미지를 읽을 수 없습니다.');
  const width = image.get_width(), height = image.get_height();
  const rgba = new Uint8ClampedArray(width * height * 4);
  return new Promise((resolve, reject) => {
    image.display({ data: rgba, width, height }, result => {
      if (!result) return reject(new Error('HEIC 디코딩에 실패했습니다.'));
      for (let i = 0; i < rgba.length; i += 4) { const r = rgba[i]; rgba[i] = rgba[i + 2]; rgba[i + 2] = r; }
      resolve({ width, height, bgra: Buffer.from(rgba.buffer) });
    });
  });
}

parentPort.on('message', async ({ id, bytes }) => {
  try {
    const result = await decode(bytes);
    parentPort.postMessage({ id, ...result }, [result.bgra.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
