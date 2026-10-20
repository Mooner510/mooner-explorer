import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseHeads, parseMediaIds } from '../src/adb.js';
import { exifThumbnail, ThumbnailStore } from '../src/thumbs.js';

const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 0xff, 0xd9]);

// JPEG with an APP1 EXIF block: IFD0 (orientation) → IFD1 (thumbnail offset/length).
function jpegWithExif({ little = true, orientation = 6, thumb = THUMB } = {}) {
  const tiff = Buffer.alloc(8 + 18 + 30 + thumb.length);
  const u16 = (value, at) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const u32 = (value, at) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  tiff.write(little ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2); u32(8, 4);
  u16(1, 8); u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(orientation, 18); u32(26, 22);
  u16(2, 26);
  u16(0x0201, 28); u16(4, 30); u32(1, 32); u32(56, 36);
  u16(0x0202, 40); u16(4, 42); u32(1, 44); u32(thumb.length, 48);
  u32(0, 52);
  thumb.copy(tiff, 56);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(app1.length + 2, 2);
  const jfif = Buffer.from([0xff, 0xe0, 0, 4, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, header, app1, Buffer.from([0xff, 0xda, 0, 2])]);
}

test('exifThumbnail extracts the embedded JPEG and orientation', () => {
  for (const little of [true, false]) {
    const found = exifThumbnail(jpegWithExif({ little }));
    assert.deepEqual(Buffer.from(found.data), THUMB);
    assert.equal(found.orientation, 6);
  }
  assert.equal(exifThumbnail(jpegWithExif({ orientation: 42 })).orientation, 1);
});

test('exifThumbnail rejects non-JPEG, missing and truncated EXIF', () => {
  assert.equal(exifThumbnail(Buffer.from('\x89PNG\r\n', 'latin1')), null);
  assert.equal(exifThumbnail(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  const full = jpegWithExif();
  assert.equal(exifThumbnail(full.subarray(0, full.length - 10)), null);
  assert.equal(exifThumbnail(jpegWithExif({ thumb: Buffer.from([1, 2, 3]) })), null);
});

test('parseHeads splits length-prefixed chunks', () => {
  const out = Buffer.concat([Buffer.from('@3\nabc@0\n@2\n\n\n'), Buffer.from('@9\nshort')]);
  assert.deepEqual(parseHeads(out, 4).map(String), ['abc', '', '\n\n']);
});

test('ThumbnailStore batches head reads, caches hits and remembers misses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
  const calls = [];
  const adb = {
    readHeads: async (serial, remotes) => { calls.push(remotes); return remotes.map(remote => (remote.includes('exif') ? jpegWithExif() : Buffer.from('plain'))); },
    mediaImageIds: async () => new Map(),
  };
  const store = new ThumbnailStore({ adb, dir });
  const item = remote => ({ remote, size: 10, modified: '2026-01-01 00:00' });
  const results = await Promise.all(['/a/exif1.jpg', '/a/exif2.jpg', '/a/plain.jpg'].map(remote => store.get('S', item(remote))));
  assert.equal(calls.length, 1);
  assert.deepEqual(Buffer.from(results[0].data), THUMB);
  assert.equal(results[2], null);
  assert.equal(await store.get('S', item('/a/shot.png')), null);
  const again = await Promise.all(['/a/exif1.jpg', '/a/plain.jpg'].map(remote => store.get('S', item(remote))));
  assert.equal(calls.length, 1);
  assert.equal(again[0].orientation, 6);
  assert.equal(again[1], null);
  await store.put('S', item('/a/shot.png'), new Uint8Array([7, 8]));
  assert.deepEqual(await store.get('S', item('/a/shot.png')), { orientation: 1, data: new Uint8Array([7, 8]) });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('parseMediaIds maps primary-storage paths to MediaStore ids', () => {
  const out = 'Row: 0 _id=12, _data=/storage/emulated/0/Pictures/a b.png\nRow: 1 _id=13, _data=/storage/ABCD-1234/x.png\n';
  assert.deepEqual([...parseMediaIds(out)], [['/Pictures/a b.png', '12']]);
});

test('ThumbnailStore falls back to the MediaStore thumbnail', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumbs-'));
  const reads = [];
  let queries = 0;
  const adb = {
    readHeads: async (serial, remotes, bytes) => { reads.push([remotes, bytes]); return remotes.map(remote => (remote.endsWith('/7.jpg') ? THUMB : Buffer.alloc(0))); },
    mediaImageIds: async () => { queries++; return new Map([['/Pictures/shot.png', '7'], ['/DCIM/raw.jpg', '8']]); },
  };
  const store = new ThumbnailStore({ adb, dir });
  const item = remote => ({ remote, size: 10, modified: '2026-01-01 00:00' });
  const [shot, raw, other] = await Promise.all(['/sdcard/Pictures/shot.png', '/sdcard/DCIM/raw.jpg', '/sdcard/Pictures/new.png'].map(remote => store.get('S', item(remote))));
  assert.deepEqual(shot, { data: new Uint8Array(THUMB), orientation: 1 });
  assert.equal(raw, null); // no EXIF thumbnail and no generated MediaStore one
  assert.equal(other, null);
  assert.equal(queries, 1);
  const mediaReads = reads.filter(([remotes]) => remotes[0].includes('.thumbnails'));
  assert.deepEqual(mediaReads.flatMap(([remotes]) => remotes).sort(), ['/storage/emulated/0/Pictures/.thumbnails/7.jpg', '/storage/emulated/0/Pictures/.thumbnails/8.jpg']);
  assert.ok(mediaReads.every(([, bytes]) => bytes > 64 * 1024 + 2048));
  fs.rmSync(dir, { recursive: true, force: true });
});
