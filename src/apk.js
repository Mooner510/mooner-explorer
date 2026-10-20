import zlib from 'node:zlib';

// Reads an app's label and launcher icon straight out of its APK. The APK is never downloaded whole:
// `read(start, length)` fetches byte ranges, so only the zip directory, the manifest, the resource table and one icon are transferred.

const TAIL_BYTES = 256 * 1024;
const LOCAL_SLACK = 4200; // zipalign pads local extra fields up to 4 KiB

export const TAIL = TAIL_BYTES;

// `readMany([[start, length], …])` → Buffers; `tail` is the file's last TAIL bytes.
export async function readZip(readMany, size, tail) {
  const tailLength = tail.length;
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip 구조를 찾을 수 없습니다.');
  const total = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  const tailStart = size - tailLength;
  const directory = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : (await readMany([[cdOffset, cdSize]]))[0];
  const entries = new Map();
  for (let pos = 0, count = 0; count < total && pos + 46 <= directory.length && directory.readUInt32LE(pos) === 0x02014b50; count++) {
    const nameLength = directory.readUInt16LE(pos + 28), extraLength = directory.readUInt16LE(pos + 30), commentLength = directory.readUInt16LE(pos + 32);
    entries.set(directory.toString('utf8', pos + 46, pos + 46 + nameLength), {
      method: directory.readUInt16LE(pos + 10), compressed: directory.readUInt32LE(pos + 20), offset: directory.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return {
    entries,
    // Reads several entries with one call; local headers carry a variable extra field, so a slack is read and topped up on a miss.
    async extractMany(names) {
      const wanted = names.map(name => entries.get(name));
      const chunks = await readMany(wanted.map(entry => (entry ? [entry.offset, Math.min(30 + entry.compressed + LOCAL_SLACK, size - entry.offset)] : [0, 0])));
      return Promise.all(wanted.map(async (entry, index) => {
        if (!entry) return null;
        let chunk = chunks[index];
        const dataStart = 30 + chunk.readUInt16LE(26) + chunk.readUInt16LE(28);
        if (dataStart + entry.compressed > chunk.length) chunk = (await readMany([[entry.offset, dataStart + entry.compressed]]))[0];
        const data = chunk.subarray(dataStart, dataStart + entry.compressed);
        return entry.method === 8 ? zlib.inflateRawSync(data) : data;
      }));
    },
    async extract(name) { return (await this.extractMany([name]))[0]; },
  };
}

function readStringPool(buffer, start) {
  const count = buffer.readUInt32LE(start + 8), flags = buffer.readUInt32LE(start + 16), stringsStart = buffer.readUInt32LE(start + 20);
  const utf8 = (flags & 0x100) !== 0, strings = new Array(count);
  const text = index => {
    if (strings[index] !== undefined) return strings[index];
    let pos = start + stringsStart + buffer.readUInt32LE(start + 28 + index * 4), value = '';
    if (utf8) {
      if (buffer[pos++] & 0x80) pos++;
      let length = buffer[pos++];
      if (length & 0x80) length = ((length & 0x7f) << 8) | buffer[pos++];
      value = buffer.toString('utf8', pos, pos + length);
    } else {
      let length = buffer.readUInt16LE(pos);
      pos += 2;
      if (length & 0x8000) { length = ((length & 0x7fff) << 16) | buffer.readUInt16LE(pos); pos += 2; }
      value = buffer.toString('utf16le', pos, pos + length * 2);
    }
    return (strings[index] = value);
  };
  return { count, text };
}

// Android binary XML → [{ name, attrs: { name: { id, type, data, text } } }] for start tags.
export function parseBinaryXml(buffer) {
  const elements = [];
  let pool = null, ids = [];
  for (let pos = 8; pos + 8 <= buffer.length;) {
    const type = buffer.readUInt16LE(pos), size = buffer.readUInt32LE(pos + 4);
    if (size < 8) break;
    if (type === 0x0001) pool = readStringPool(buffer, pos);
    else if (type === 0x0180) for (let i = 8; i + 4 <= size; i += 4) ids.push(buffer.readUInt32LE(pos + i));
    else if (type === 0x0102 && pool) {
      const attrStart = pos + 16 + buffer.readUInt16LE(pos + 24), attrSize = buffer.readUInt16LE(pos + 26), attrCount = buffer.readUInt16LE(pos + 28);
      const attrs = {};
      for (let i = 0; i < attrCount; i++) {
        const at = attrStart + i * attrSize, nameIndex = buffer.readUInt32LE(at + 4), valueType = buffer[at + 15], data = buffer.readUInt32LE(at + 16);
        const text = valueType === 0x03 ? pool.text(data) : null;
        const attr = { id: ids[nameIndex] ?? 0, type: valueType, data, text };
        attrs[pool.text(nameIndex)] = attr;
        if (attr.id) attrs[`#${attr.id}`] = attr;
      }
      elements.push({ name: pool.text(buffer.readUInt32LE(pos + 20)), attrs });
    }
    pos += size;
  }
  return elements;
}

const attrOf = (element, name, id) => element?.attrs[name] ?? element?.attrs[`#${id}`];

// resources.arsc, queried lazily: lookup(resId) → every configuration's value for that resource.
export function parseResourceTable(buffer) {
  let pool = null;
  const packages = new Map(); // package id → [{ typeId, config, offset, size }]
  for (let pos = buffer.readUInt16LE(2); pos + 8 <= buffer.length;) {
    const type = buffer.readUInt16LE(pos), size = buffer.readUInt32LE(pos + 4);
    if (size < 8) break;
    if (type === 0x0001 && !pool) pool = readStringPool(buffer, pos);
    else if (type === 0x0200) {
      const chunks = [];
      packages.set(buffer.readUInt32LE(pos + 8), chunks);
      for (let at = pos + buffer.readUInt16LE(pos + 2); at + 8 <= pos + size;) {
        const chunkType = buffer.readUInt16LE(at), chunkSize = buffer.readUInt32LE(at + 4);
        if (chunkSize < 8) break;
        if (chunkType === 0x0201) {
          const configAt = at + 20;
          chunks.push({
            at, typeId: buffer[at + 8], flags: buffer[at + 9], count: buffer.readUInt32LE(at + 12), entries: buffer.readUInt32LE(at + 16),
            language: buffer.toString('latin1', configAt + 8, configAt + 10).replace(/\0/g, ''), density: buffer.readUInt16LE(configAt + 14),
            offsets: at + buffer.readUInt16LE(at + 2),
          });
        }
        at += chunkSize;
      }
    }
    pos += size;
  }
  const entryOffset = (chunk, index) => {
    if (chunk.flags & 1) { // sparse: (entry index, offset / 4) pairs
      for (let i = 0; i < chunk.count; i++) {
        const packed = buffer.readUInt32LE(chunk.offsets + i * 4);
        if ((packed & 0xffff) === index) return (packed >>> 16) * 4;
      }
      return -1;
    }
    if (index >= chunk.count) return -1;
    const offset = buffer.readUInt32LE(chunk.offsets + index * 4);
    return offset === 0xffffffff ? -1 : offset;
  };
  return {
    lookup(id) {
      const found = [];
      for (const chunk of packages.get(id >>> 24) ?? []) {
        if (chunk.typeId !== ((id >>> 16) & 0xff)) continue;
        const offset = entryOffset(chunk, id & 0xffff);
        if (offset < 0) continue;
        const entry = chunk.at + chunk.entries + offset;
        if (buffer.readUInt16LE(entry + 2) & 1) continue; // bag (style/plurals), not a plain value
        const valueType = buffer[entry + 11], data = buffer.readUInt32LE(entry + 12);
        found.push({ language: chunk.language, density: chunk.density, type: valueType, data, text: valueType === 0x03 ? pool?.text(data) ?? null : null });
      }
      return found;
    },
  };
}

const bestLabel = values => (values.find(v => v.language === 'ko') ?? values.find(v => !v.language) ?? values[0]);

function resolveLabel(attr, table) {
  for (let hop = 0; attr && hop < 4; hop++) {
    if (attr.type === 0x03) return attr.text;
    if (attr.type !== 0x01 || !table) return null;
    attr = bestLabel(table.lookup(attr.data).filter(v => v.type === 0x03 || v.type === 0x01));
  }
  return null;
}

const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const extensionOf = file => file.slice(file.lastIndexOf('.') + 1).toLowerCase();
const colorOf = value => { const hex = (value >>> 0).toString(16).padStart(8, '0'); return `#${hex.slice(2)}${hex.slice(0, 2)}`; }; // ARGB → CSS #rrggbbaa

async function bitmapOf(zip, path) {
  const mime = MIME[extensionOf(path)];
  const data = mime && await zip.extract(path);
  return data ? `data:${mime};base64,${data.toString('base64')}` : null;
}

// A drawable reference → data URL (png/webp), colour, or `{ xml }` path when only an XML drawable exists.
async function resolveDrawable(zip, table, attr, depth = 0) {
  if (!attr || !table || depth > 3) return null;
  if (attr.type >= 0x1c && attr.type <= 0x1f) return { color: colorOf(attr.data) };
  if (attr.type !== 0x01) return null;
  const values = table.lookup(attr.data);
  const files = values.filter(v => v.type === 0x03 && v.text);
  const bitmaps = files.filter(v => MIME[extensionOf(v.text)]).sort((a, b) => Math.abs(a.density - 320) - Math.abs(b.density - 320));
  for (const file of bitmaps) { const url = await bitmapOf(zip, file.text); if (url) return { image: url }; }
  const color = values.find(v => v.type >= 0x1c && v.type <= 0x1f);
  if (color) return { color: colorOf(color.data) };
  const xml = files.find(v => extensionOf(v.text) === 'xml');
  if (xml) return { xml: xml.text };
  const ref = values.find(v => v.type === 0x01);
  return ref ? resolveDrawable(zip, table, ref, depth + 1) : null;
}

async function resolveIcon(zip, table, attr) {
  const drawable = await resolveDrawable(zip, table, attr);
  if (!drawable) return null;
  if (drawable.image) return { image: drawable.image };
  if (!drawable.xml) return null;
  // Adaptive icon: stack background and foreground bitmaps (vector layers can't be drawn here).
  const xml = await zip.extract(drawable.xml);
  const root = xml && parseBinaryXml(xml);
  const layer = async name => {
    const element = root?.find(item => item.name === name);
    const found = await resolveDrawable(zip, table, attrOf(element, 'drawable', 0x01010199));
    return found?.image ? { image: found.image } : found?.color ? { color: found.color } : null;
  };
  if (root?.[0]?.name !== 'adaptive-icon') return null;
  const foreground = await layer('foreground');
  return foreground?.image ? { foreground: foreground.image, background: await layer('background') } : null;
}

// → { label, icon } where icon is { image } | { foreground, background } | null.
export async function readAppMeta(readMany, size, tail) {
  const zip = await readZip(readMany, size, tail);
  const [manifest, arsc] = await zip.extractMany(['AndroidManifest.xml', 'resources.arsc']);
  if (!manifest) return { label: null, icon: null };
  const application = parseBinaryXml(manifest).find(element => element.name === 'application');
  const labelAttr = attrOf(application, 'label', 0x01010001), iconAttr = attrOf(application, 'icon', 0x01010002);
  const table = arsc ? parseResourceTable(arsc) : null;
  return { label: resolveLabel(labelAttr, table)?.trim() || null, icon: await resolveIcon(zip, table, iconAttr) };
}
