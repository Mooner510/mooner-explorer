import { Worker } from 'node:worker_threads';
import { nativeImage } from 'electron';

// Chromium은 HEIC/HEIF를 디코딩하지 못하므로, 기기에서 받은 파일을 WASM(libheif)으로 풀어 JPEG로 바꿔 미리보기에 쓴다.
export const HEIC_EXT = /\.(heic|heif|hif)$/i;
const JPEG_QUALITY = 90;

let worker = null;
let nextId = 0;
const pending = new Map();

function failAll(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
  worker = null;
}

function getWorker() {
  if (worker) return worker;
  const created = new Worker(new URL('./heic-worker.js', import.meta.url));
  created.on('message', ({ id, error, ...result }) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (error) entry.reject(new Error(error)); else entry.resolve(result);
  });
  created.on('error', failAll);
  created.on('exit', () => { if (worker === created) failAll(new Error('HEIC 디코더가 종료되었습니다.')); });
  return worker = created;
}

// HEIC 파일 내용(Buffer) → JPEG Buffer. 디코딩은 워커 하나가 차례대로 처리한다.
export async function heicToJpeg(bytes) {
  const { width, height, bgra } = await new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, bytes: new Uint8Array(bytes) });
  });
  return nativeImage.createFromBitmap(Buffer.from(bgra), { width, height }).toJPEG(JPEG_QUALITY);
}
