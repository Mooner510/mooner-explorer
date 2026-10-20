import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAppMeta, TAIL } from './apk.js';

const VERSION = 2; // bump when the parser's output changes so stale cache files are ignored

// App label + icon, read from each APK once and kept on the PC. An APK's install path changes on every update,
// so (serial, path) identifies one build of an app.
export class AppMetaStore {
  constructor({ adb, dir }) {
    this.adb = adb;
    this.dir = dir;
    this.pending = new Map();
  }

  file(serial, apk) {
    return path.join(this.dir, `${createHash('sha1').update([VERSION, serial, apk].join('|')).digest('hex')}.json`);
  }

  async get(serial, apk) {
    if (!apk) return null;
    const file = this.file(serial, apk);
    const cached = await fs.promises.readFile(file, 'utf8').then(JSON.parse, () => null);
    if (cached) return cached;
    let task = this.pending.get(file);
    if (!task) {
      task = this.load(serial, apk).then(async meta => {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(file, JSON.stringify(meta));
        return meta;
      }).catch(() => null).finally(() => this.pending.delete(file)); // unreadable APKs just keep their package name
      this.pending.set(file, task);
    }
    return task;
  }

  async load(serial, apk) {
    const { size, tail } = await this.adb.fileTail(serial, apk, TAIL);
    return readAppMeta(ranges => this.adb.readRanges(serial, apk, ranges), size, tail);
  }
}
