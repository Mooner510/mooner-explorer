import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { primaryPath } from './adb.js';

// An APP1 (EXIF) segment is at most 64 KiB and sits right after SOI (plus an optional JFIF APP0), so this covers it.
export const HEAD_BYTES = 64 * 1024 + 2048;
// Android 10+ keeps the thumbnails it generates at Pictures/.thumbnails/<MediaStore id>.jpg (typically 40–100 KB).
const MEDIA_THUMBS = '/storage/emulated/0/Pictures/.thumbnails';
const MEDIA_THUMB_BYTES = 512 * 1024;
const MEDIA_IDS_TTL = 30_000;
const BATCH = 16;
const PARALLEL = 2;

// Pulls the small JPEG most cameras embed in EXIF (IFD1) out of a file's leading bytes.
// Returns { data, orientation } or null; the orientation belongs to the main image and applies to the thumbnail too.
export function exifThumbnail(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buffer.length) {
    if (buffer[pos] !== 0xff) return null;
    const marker = buffer[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { pos += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return null;
    const start = pos + 4, end = pos + 2 + buffer.readUInt16BE(pos + 2);
    if (marker === 0xe1 && buffer.toString('latin1', start, start + 6) === 'Exif\0\0') return tiffThumbnail(buffer.subarray(start + 6, Math.min(end, buffer.length)));
    pos = end;
  }
  return null;
}

function tiffThumbnail(tiff) {
  try {
    const order = tiff.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return null;
    const little = order === 'II';
    const u16 = offset => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
    const u32 = offset => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
    const ifd = offset => {
      const tags = new Map();
      const count = u16(offset);
      for (let i = 0; i < count; i++) {
        const entry = offset + 2 + i * 12;
        tags.set(u16(entry), u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));
      }
      return { tags, next: u32(offset + 2 + count * 12) };
    };
    const ifd0 = ifd(u32(4));
    if (!ifd0.next) return null;
    const ifd1 = ifd(ifd0.next);
    const offset = ifd1.tags.get(0x0201), length = ifd1.tags.get(0x0202);
    if (!offset || !length || offset + length > tiff.length || tiff[offset] !== 0xff || tiff[offset + 1] !== 0xd8) return null;
    const orientation = ifd0.tags.get(0x0112);
    return { data: new Uint8Array(tiff.subarray(offset, offset + length)), orientation: orientation >= 1 && orientation <= 8 ? orientation : 1 };
  } catch {
    return null; // truncated or malformed EXIF
  }
}

// Small thumbnails kept on the PC so each image is read from the device only once.
// A cache file is one orientation byte followed by the encoded image.
export class ThumbnailStore {
  constructor({ adb, dir }) {
    this.adb = adb;
    this.dir = dir;
    this.misses = new Set();
    this.queues = new Map();
    this.mediaIds = new Map(); // serial → { time, ids: Promise<Map> }
  }

  file(serial, { remote, size, modified }) {
    return path.join(this.dir, createHash('sha1').update([serial, remote, size, modified].join('|')).digest('hex'));
  }

  async get(serial, item) {
    const file = this.file(serial, item);
    const cached = await fs.promises.readFile(file).catch(() => null);
    if (cached?.length > 1) return { orientation: cached[0], data: new Uint8Array(cached.subarray(1)) };
    if (this.misses.has(file)) return null;
    const thumb = (await this.exifFor(serial, item.remote)) ?? (await this.mediaFor(serial, item.remote));
    if (!thumb) { this.misses.add(file); return null; }
    await this.write(file, thumb.orientation, thumb.data);
    return thumb;
  }

  async exifFor(serial, remote) {
    if (!/\.(jpe?g|jfif)$/i.test(remote)) return null;
    const head = await this.readHead(serial, remote, HEAD_BYTES);
    return head && exifThumbnail(head);
  }

  // The thumbnail MediaProvider already made (gallery apps trigger it), so PNG/WebP and EXIF-less photos need not be pulled whole.
  async mediaFor(serial, remote) {
    const local = primaryPath(remote);
    const id = local && (await this.mediaIdsOf(serial)).get(local);
    if (!id) return null;
    const data = await this.readHead(serial, `${MEDIA_THUMBS}/${id}.jpg`, MEDIA_THUMB_BYTES);
    // A read that fills the whole budget may be truncated; MediaProvider already applied EXIF rotation.
    if (!data || data.length >= MEDIA_THUMB_BYTES || data[0] !== 0xff || data[1] !== 0xd8) return null;
    return { data: new Uint8Array(data), orientation: 1 };
  }

  mediaIdsOf(serial) {
    let entry = this.mediaIds.get(serial);
    if (!entry || Date.now() - entry.time > MEDIA_IDS_TTL) {
      entry = { time: Date.now(), ids: this.adb.mediaImageIds(serial).catch(() => new Map()) };
      this.mediaIds.set(serial, entry);
    }
    return entry.ids;
  }

  async put(serial, item, data) {
    if (!(data instanceof Uint8Array) || !data.length || data.length > 2 * 1024 * 1024) return;
    await this.write(this.file(serial, item), 1, data);
  }

  async write(file, orientation, data) {
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(temp, Buffer.concat([Buffer.of(orientation), data]));
      await fs.promises.rename(temp, file);
    } catch {
      await fs.promises.rm(temp, { force: true });
    }
  }

  // Head reads are gathered into one adb call per batch so a folder of photos spawns a handful of processes, not hundreds.
  readHead(serial, remote, bytes) {
    return new Promise(resolve => {
      const key = `${serial}|${bytes}`;
      let queue = this.queues.get(key);
      if (!queue) this.queues.set(key, queue = { bytes, items: [], running: 0, timer: null });
      queue.items.push({ remote, resolve });
      queue.timer ??= setTimeout(() => { queue.timer = null; this.pump(serial, queue); }, 10);
    });
  }

  pump(serial, queue) {
    while (queue.running < PARALLEL && queue.items.length) {
      const batch = queue.items.splice(0, BATCH);
      queue.running++;
      this.adb.readHeads(serial, batch.map(item => item.remote), queue.bytes).catch(() => []).then(heads => {
        batch.forEach((item, index) => item.resolve(heads[index]?.length ? heads[index] : null));
        queue.running--;
        this.pump(serial, queue);
      });
    }
  }

  // Drops the oldest entries once the cache grows past maxBytes.
  async prune(maxBytes) {
    const names = await fs.promises.readdir(this.dir).catch(() => []);
    const files = (await Promise.all(names.map(async name => {
      const file = path.join(this.dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      return stat?.isFile() ? { file, size: stat.size, time: stat.mtimeMs } : null;
    }))).filter(Boolean).sort((a, b) => a.time - b.time);
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= maxBytes) return;
    for (const entry of files) {
      if (total <= maxBytes * 0.75) break;
      await fs.promises.rm(entry.file, { force: true });
      total -= entry.size;
    }
  }
}
