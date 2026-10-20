'use strict';

// 파일 탭: Windows 탐색기 형태의 기기 파일 관리자. app.js보다 먼저 로드되어 renderFiles를 제공한다.
// h, toast, attempt, busy, openModal, confirmDialog, promptDialog, deviceState, formatBytes, joinRemote, parentRemote, iconPath는 다른 스크립트의 전역을 쓴다.

const FX_VIEWS = [
  ['xlarge', '아주 큰 아이콘', 96],
  ['large', '큰 아이콘', 64],
  ['medium', '보통 아이콘', 40],
  ['small', '작은 아이콘', 20],
  ['list', '목록', 20],
  ['details', '자세히', 20],
];
const FX_THUMB_VIEWS = new Set(['xlarge', 'large', 'medium']);
const FX_THUMB_MAX_BYTES = 12 * 1024 * 1024;
const FX_SORT_KEYS = [['name', '이름'], ['modified', '수정한 날짜'], ['type', '유형'], ['size', '크기']];
const FX_PREVIEW_EXT = {
  image: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'mkv'],
  pdf: ['pdf'],
  text: Object.keys(HL_EXT),
};
const FX_TEXT_MAX_BYTES = 256 * 1024;

// 앞부분만 읽고 스트림을 끊는다(끊으면 main의 adb 자식 프로세스도 종료된다).
async function fxReadText(src, limit) {
  const response = await fetch(src);
  if (!response.ok) throw new Error(await response.text());
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0, truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > limit) { truncated = true; reader.cancel().catch(() => {}); break; }
  }
  const bytes = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

const fxPrefs = {
  get(key, fallback) {
    try { const value = localStorage.getItem(`files.${key}`); return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`files.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

// 탭을 오가도 유지되는 앱 내부 클립보드: { serial, mode: 'copy' | 'cut', sources: [원격 경로] }
let fxClipboard = null;

const fxExt = name => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
const fxPreviewKind = name => Object.keys(FX_PREVIEW_EXT).find(kind => FX_PREVIEW_EXT[kind].includes(fxExt(name))) ?? null;
const fxPreviewUrl = (serial, remote) => `mooner-preview://f/${encodeURIComponent(serial)}${remote.split('/').map(encodeURIComponent).join('/')}`;
const fxIsFolder = entry => entry.type === 'dir';
const fxTypeLabel = entry => ({ dir: '파일 폴더', link: '바로 가기', other: '장치 파일' })[entry.type] ?? (fxExt(entry.name) ? `${fxExt(entry.name).toUpperCase()} 파일` : '파일');
const fxSizeLabel = entry => (entry.type === 'file' || entry.type === 'link') && entry.size != null ? formatBytes(entry.size) : '';

const FX_COMPARE = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
  modified: (a, b) => a.modified.localeCompare(b.modified),
  type: (a, b) => fxTypeLabel(a).localeCompare(fxTypeLabel(b)),
};

// ---- 썸네일 ----
// 원본 대신 작은 썸네일만 쓴다: 사진은 EXIF에 내장된 썸네일(파일 앞 64KB만 읽음), 그다음 Android가 만들어 둔
// MediaStore 썸네일(Pictures/.thumbnails), 둘 다 없으면 원본을 한 번만 받아 줄인 뒤
// PC 캐시(main의 ThumbnailStore)에 저장한다. 화면에 보이는 항목만, 동시에 몇 개씩만 불러온다.
const FX_THUMB_WIDTH = 320;
const FX_THUMB_RAW_BYTES = 160 * 1024; // 이보다 작은 이미지는 줄이지 않고 그대로 쓴다
const FX_THUMB_MEMORY = 3000;
const fxThumbMemory = new Map(); // 캐시 키 → { url, orientation }, 오래된 것부터 해제
const fxThumbKey = (serial, item) => [serial, item.remote, item.size, item.modified].join('|');

function fxRememberThumb(key, data, orientation) {
  const thumb = { url: URL.createObjectURL(new Blob([data])), orientation };
  fxThumbMemory.set(key, thumb);
  if (fxThumbMemory.size > FX_THUMB_MEMORY) {
    const [oldest, old] = fxThumbMemory.entries().next().value;
    fxThumbMemory.delete(oldest);
    URL.revokeObjectURL(old.url);
  }
  return thumb;
}

async function fxShrinkImage(url, name) {
  const blob = await (await fetch(url)).blob();
  if (blob.size <= FX_THUMB_RAW_BYTES || fxExt(name) === 'svg') return blob;
  const bitmap = await createImageBitmap(blob, { resizeWidth: FX_THUMB_WIDTH, resizeQuality: 'medium' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  } finally {
    bitmap.close();
  }
}

// 폴더 화면 하나가 쓰는 썸네일 로더. reset()은 다시 그릴 때, 대기 중인 작업을 버린다.
function fxThumbLoader(serial, root) {
  // 화면(+여유분) 안에 있는 이미지만 대기열에 둔다. 빠르게 스크롤해 지나간 항목은 시작 전이면 빠진다.
  const visible = new Set(), lookups = new Set(), shrinks = new Set();
  let running = 0, shrinking = 0;
  const observer = new IntersectionObserver(records => {
    for (const { target, isIntersecting } of records) {
      if (isIntersecting) { visible.add(target); if (!target.fxThumb.busy) (target.fxThumb.stage === 'shrink' ? shrinks : lookups).add(target); }
      else { visible.delete(target); lookups.delete(target); shrinks.delete(target); }
    }
    pump();
  }, { root, rootMargin: '200px 0px' });

  const show = (image, thumb) => {
    image.src = thumb.url;
    image.classList.add('fx-thumb');
    if (thumb.orientation > 1) image.dataset.orient = thumb.orientation;
  };
  const take = set => { const [first] = set; set.delete(first); return first; };
  const finish = image => { observer.unobserve(image); visible.delete(image); };

  function pump() {
    // 조회는 main에서 adb 호출 하나로 묶이므로 한 번에 넉넉히 보내야 묶음이 꽉 찬다.
    while (running < 32 && lookups.size) lookup(take(lookups));
    while (shrinking < 2 && shrinks.size) shrink(take(shrinks));
  }

  async function lookup(image) {
    running++;
    image.fxThumb.busy = true;
    const { item } = image.fxThumb;
    try {
      const found = await api.call('files:thumb', serial, item);
      if (found) { show(image, fxRememberThumb(fxThumbKey(serial, item), found.data, found.orientation)); finish(image); }
      else if (item.size > FX_THUMB_MAX_BYTES) finish(image); // 내장 썸네일이 없는 큰 파일은 통째로 받지 않는다
      else { image.fxThumb.stage = 'shrink'; if (visible.has(image)) shrinks.add(image); }
    } catch { finish(image); }
    image.fxThumb.busy = false;
    running--;
    pump();
  }

  async function shrink(image) {
    shrinking++;
    image.fxThumb.busy = true;
    const { item, name } = image.fxThumb;
    try {
      const blob = await fxShrinkImage(`${fxPreviewUrl(serial, item.remote)}?size=${item.size}`, name);
      const data = new Uint8Array(await blob.arrayBuffer());
      show(image, fxRememberThumb(fxThumbKey(serial, item), data, 1));
      api.call('files:thumbStore', serial, item, data).catch(() => {});
    } catch { /* 디코딩할 수 없는 이미지는 아이콘 유지 */ }
    finish(image);
    shrinking--;
    pump();
  }

  return {
    attach(image, entry, remote) {
      const item = { remote, size: entry.size, modified: entry.modified };
      const known = fxThumbMemory.get(fxThumbKey(serial, item));
      if (known) { show(image, known); return; }
      image.fxThumb = { item, name: entry.name, stage: 'lookup' };
      observer.observe(image);
    },
    reset() { observer.disconnect(); visible.clear(); lookups.clear(); shrinks.clear(); },
  };
}

// 클릭한 위치나 버튼 아래에 뜨는 메뉴 (컨텍스트 메뉴, 보기/정렬/업로드 드롭다운 공용)
function fxMenu(x, y, items) {
  document.querySelector('.fx-menu')?.remove();
  const close = () => {
    leave(menu, 160);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
  };
  const onOutside = event => { if (!menu.contains(event.target)) close(); };
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  const menu = h('div', { class: 'fx-menu', role: 'menu' }, items.map(item => item.separator
    ? h('hr')
    : h('button', { class: 'fx-menu-item', role: 'menuitem', disabled: item.disabled, onclick: () => { close(); item.action(); } },
      h('span', { class: 'fx-check' }, item.checked ? '✓' : ''), item.icon ? fxCmdIcon(item.icon) : null, h('span', { class: 'fx-menu-label' }, item.label), item.hint ? h('kbd', null, item.hint) : null)));
  $('.window').append(menu);
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  return close;
}

function fxLightbox(src, name, kind = 'image') {
  const close = () => { leave(overlay, 160); document.removeEventListener('keydown', onKey, true); };
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  const overlay = kind === 'pdf'
    ? h('div', { class: 'fx-lightbox fx-lightbox-pdf' }, h('iframe', { src, title: name }),
      h('div', { class: 'fx-lightbox-name' }, name),
      h('button', { class: 'icon-button fx-lightbox-close', title: '닫기 (Esc)', onclick: close }, '✕'))
    : h('div', { class: 'fx-lightbox', onclick: close, title: '클릭하거나 Esc로 닫기' }, h('img', { src, alt: name }), h('div', { class: 'fx-lightbox-name' }, name));
  document.addEventListener('keydown', onKey, true);
  $('.window').append(overlay);
  return close;
}

// 명령 모음 버튼용 선 아이콘 (24×24, stroke 기반)
const FX_CMD_ICONS = {
  'folder-plus': ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M12 10v6', 'M9 13h6'],
  scissors: ['M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M20 4 8.1 15.9', 'M14.5 14.5 20 20', 'M8.1 8.1 12 12'],
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z', 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'],
  clipboard: ['M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z', 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'],
  pencil: ['M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'M15 5l4 4'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6'],
  'file-up': ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6', 'M12 18v-6', 'M9 15l3-3 3 3'],
  'folder-up': ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M12 17v-6', 'M9 14l3-3 3 3'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  sort: ['M11 5h10', 'M11 9h7', 'M11 13h4', 'M3 17l3 3 3-3', 'M6 18V4'],
  layout: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M3 9h18', 'M9 21V9'],
  panel: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M15 3v18'],
  wrap: ['M3 6h18', 'M3 12h15a3 3 0 0 1 0 6h-4', 'M16 15l-2 3 2 3', 'M3 18h7'],
};

function fxCmdIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'fx-cmd-icon' })) svg.setAttribute(key, value);
  svg.dataset.icon = name;
  for (const d of FX_CMD_ICONS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// 빈 폴더 / 검색 결과 없음 안내. 폴더 아이콘이 떠다니고 뚜껑이 살짝 열렸다 닫힌다.
function fxEmptyState(message, searching) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 96 96', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'fx-empty-icon' })) svg.setAttribute(key, value);
  const add = (tag, attrs, className) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (className) node.setAttribute('class', className);
    svg.append(node);
  };
  add('path', { d: 'M10 28a6 6 0 0 1 6-6h20l8 9h36a6 6 0 0 1 6 6v33a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6Z' }, 'fx-empty-back');
  add('path', { d: 'M10 42h76' }, 'fx-empty-lid');
  if (searching) {
    add('circle', { cx: 48, cy: 60, r: 8 }, 'fx-empty-mark');
    add('path', { d: 'M54 66l7 7' }, 'fx-empty-mark');
  } else {
    add('path', { d: 'M38 60h20' }, 'fx-empty-mark');
  }
  return h('div', { class: 'fx-empty', role: 'status' },
    h('div', { class: 'fx-empty-art' }, svg, h('span', { class: 'fx-empty-shadow' }), h('i', { class: 'fx-empty-dot' }), h('i', { class: 'fx-empty-dot' }), h('i', { class: 'fx-empty-dot' })),
    h('div', { class: 'fx-empty-text' }, message));
}

function renderFiles(view, serial) {
  const ds = deviceState();
  ds.nav ??= { back: [], forward: [] };
  const treeRoot = state.devMode ? '/' : '/sdcard';
  // 개발자 모드를 끈 상태에서는 /sdcard 밖에 머무르지 않는다.
  if (!state.devMode && ds.cwd !== treeRoot && !ds.cwd.startsWith(`${treeRoot}/`)) ds.cwd = treeRoot;
  let entries = [], shown = [], selected = new Set(), anchor = null, cursor = null, filter = '', alive = true, loadToken = 0;
  let viewMode = fxPrefs.get('view', 'details');
  if (!FX_VIEWS.some(([key]) => key === viewMode)) viewMode = 'details';
  let sort = fxPrefs.get('sort', { key: 'name', dir: 1 });
  if (!FX_COMPARE[sort?.key] || ![1, -1].includes(sort.dir)) sort = { key: 'name', dir: 1 };
  let previewOn = fxPrefs.get('preview', false);
  let previewing = null; // { entry, remote, kind }
  let closeLightbox = null;

  // ---- DOM ----

  const cmd = (icon, label, onclick, props) => h('button', { class: 'fx-cmd-btn', dataset: { icon }, onclick, ...props }, fxCmdIcon(icon), label);
  const back = h('button', { class: 'icon-button', title: '뒤로 (Alt+←)', onclick: () => goBack() }, '←');
  const forward = h('button', { class: 'icon-button', title: '앞으로 (Alt+→)', onclick: () => goForward() }, '→');
  const up = h('button', { class: 'icon-button', title: '상위 폴더 (Alt+↑)', onclick: () => navigate(parentRemote(ds.cwd)) }, '↑');
  const refresh = h('button', { class: 'icon-button', title: '새로 고침 (F5)', onclick: () => load(true) }, '⟳');
  // 개발자 모드가 꺼져 있으면 주소창의 "/" 는 기기의 /sdcard 를 뜻한다.
  const toDisplayPath = remote => (treeRoot === '/' ? remote : remote.slice(treeRoot.length) || '/');
  const fromDisplayPath = typed => {
    if (treeRoot === '/') return typed;
    const path = typed.startsWith(`${treeRoot}/`) || typed === treeRoot ? typed : `${treeRoot}/${typed}`;
    return path.replace(/\/+/g, '/');
  };
  const crumbs = h('div', { class: 'fx-crumbs' });
  const pathInput = h('input', {
    class: 'fx-path-input', spellcheck: false, hidden: true,
    onkeydown: event => { if (event.key === 'Enter') { const value = fromDisplayPath(pathInput.value.trim() || '/'); stopAddressEdit(); navigate(value); } else if (event.key === 'Escape') stopAddressEdit(); },
    onblur: () => stopAddressEdit(),
  });
  const star = h('button', { class: 'fx-star', tabindex: -1, onmousedown: event => event.preventDefault(), onclick: event => { event.stopPropagation(); toggleFavorite(ds.cwd); } });
  const address = h('div', { class: 'fx-address', title: '빈 곳을 클릭하면 경로를 직접 입력할 수 있습니다 (Ctrl+L)', onclick: event => { if (event.target === address || event.target === crumbs) startAddressEdit(); } }, crumbs, pathInput, star);
  const search = h('input', { class: 'input fx-search', placeholder: '현재 폴더에서 검색 (Ctrl+F)', spellcheck: false, oninput: () => { filter = search.value.toLowerCase(); draw(); } });

  const buttons = {
    mkdir: cmd('folder-plus', '새 폴더', () => mkdir(), { title: '새 폴더 (Ctrl+Shift+N)' }),
    cut: cmd('scissors', '잘라내기', () => copySelection('cut'), { title: '잘라내기 (Ctrl+X)' }),
    copy: cmd('copy', '복사', () => copySelection('copy'), { title: '복사 (Ctrl+C)' }),
    paste: cmd('clipboard', '붙여넣기', () => paste(), { title: '붙여넣기 (Ctrl+V)' }),
    rename: cmd('pencil', '이름 바꾸기', () => rename(), { title: '이름 바꾸기 (F2)' }),
    remove: cmd('trash', '삭제', () => remove(), { title: '삭제 (Delete)' }),
    upload: cmd('upload', '업로드 ▾', event => uploadMenu(event.currentTarget)),
    download: cmd('download', '다운로드', () => download()),
    sort: cmd('sort', '정렬 ▾', event => sortMenu(event.currentTarget)),
    view: cmd('layout', '보기 ▾', event => viewMenu(event.currentTarget)),
    preview: cmd('panel', '미리보기 창', () => togglePreview(), { title: '미리보기 창 켜기/끄기 (Alt+P)' }),
  };
  const commandBar = h('div', { class: 'fx-cmd' },
    buttons.mkdir, h('span', { class: 'sep' }), buttons.cut, buttons.copy, buttons.paste, buttons.rename, buttons.remove,
    h('span', { class: 'sep' }), buttons.upload, buttons.download, h('span', { class: 'spacer' }), buttons.sort, buttons.view, buttons.preview);

  const side = h('nav', { class: 'fx-side', 'aria-label': '폴더 트리' });

  const head = h('div', { class: 'fx-head' }, FX_SORT_KEYS.map(([key, label]) => h('button', { class: `fx-head-cell ${key}`, dataset: { key }, onclick: () => setSort(key) }, label)), h('span', { class: 'fx-head-cell perm' }, '권한'));
  const area = h('div', { class: 'fx-area', role: 'listbox', 'aria-multiselectable': 'true' });
  const scroller = h('div', { class: 'fx-scroll drop-target', tabindex: 0 }, head, area);

  const previewTitle = h('span', { class: 'fx-preview-title' }, '미리보기');
  const previewBody = h('div', { class: 'fx-preview-body' });
  const pane = h('aside', { class: 'fx-preview', 'aria-label': '미리보기', hidden: true },
    h('header', null, previewTitle, h('button', { class: 'icon-button', title: '미리보기 창 닫기', onclick: () => togglePreview(false) }, '✕')), previewBody);

  // 사이드바·미리보기 창 폭 조절: 핸들을 드래그하거나 방향키로 움직이고, 폭은 저장해 둔다.
  const SIDE_RANGE = [160, 520];
  const PANE_RANGE = [240, 800];
  const clampWidth = (value, [min, max]) => Math.round(Math.min(max, Math.max(min, value)));
  let sideWidth = clampWidth(fxPrefs.get('sideWidth', 240), SIDE_RANGE);
  let paneWidth = clampWidth(fxPrefs.get('paneWidth', 360), PANE_RANGE);
  const applyWidths = () => { side.style.width = `${sideWidth}px`; pane.style.width = `${paneWidth}px`; };
  function makeSplitter(label, getWidth, setWidth, direction) {
    const splitter = h('div', { class: 'fx-splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': label, tabindex: 0, title: '드래그하여 크기 조절 (더블클릭: 기본값)' });
    splitter.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = getWidth();
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
      document.body.classList.add('fx-resizing');
      const move = e => setWidth(startWidth + (e.clientX - startX) * direction, false);
      const stop = () => {
        splitter.removeEventListener('pointermove', move);
        splitter.removeEventListener('pointerup', stop);
        splitter.removeEventListener('pointercancel', stop);
        splitter.classList.remove('dragging');
        document.body.classList.remove('fx-resizing');
        setWidth(getWidth(), true);
      };
      splitter.addEventListener('pointermove', move);
      splitter.addEventListener('pointerup', stop);
      splitter.addEventListener('pointercancel', stop);
    });
    splitter.addEventListener('dblclick', () => setWidth(null, true));
    splitter.addEventListener('keydown', event => {
      const step = event.shiftKey ? 40 : 10;
      if (event.key === 'ArrowLeft') setWidth(getWidth() - step * direction, true);
      else if (event.key === 'ArrowRight') setWidth(getWidth() + step * direction, true);
      else return;
      event.preventDefault();
    });
    return splitter;
  }
  const sideSplitter = makeSplitter('폴더 트리 폭 조절', () => sideWidth, (value, save) => {
    sideWidth = value == null ? 240 : clampWidth(value, SIDE_RANGE);
    applyWidths();
    if (save) fxPrefs.set('sideWidth', sideWidth);
  }, 1);
  const paneSplitter = makeSplitter('미리보기 창 폭 조절', () => paneWidth, (value, save) => {
    paneWidth = value == null ? 360 : clampWidth(value, PANE_RANGE);
    applyWidths();
    if (save) fxPrefs.set('paneWidth', paneWidth);
  }, -1);
  paneSplitter.hidden = true;
  applyWidths();

  const statusText = h('span');
  const hint = h('span', { class: 'fx-hint' });
  const viewSwitch = h('span', { class: 'fx-view-switch' },
    [['details', '자세히', '☰'], ['large', '큰 아이콘', '▦']].map(([key, label, glyph]) => h('button', { class: 'icon-button', title: label, dataset: { view: key }, onclick: () => setView(key) }, glyph)));
  const devToggle = h('button', {
    class: `fx-dev-toggle${state.devMode ? ' active' : ''}`, role: 'switch', 'aria-checked': String(state.devMode),
    title: '켜면 기기 전체(/)를, 끄면 /sdcard를 트리의 루트로 보여줍니다',
    onclick: () => api.call('view:setDevMode', !state.devMode).then(enabled => { state.devMode = enabled; renderView(); }, error => toast(error.message, 'error')),
  }, '개발자 모드로 보기');
  const root = h('div', { class: 'fx' },
    h('div', { class: 'fx-nav' }, back, forward, up, address, refresh, search),
    commandBar,
    h('div', { class: 'fx-body' }, side, sideSplitter, scroller, paneSplitter, pane),
    h('div', { class: 'statusbar' }, statusText, hint, h('span', { class: 'fx-status-right' }, devToggle, viewSwitch)));
  view.append(root);
  const thumbs = fxThumbLoader(serial, scroller);

  // ---- 데이터 ----

  const remoteOf = entry => joinRemote(ds.cwd, entry.name);
  const byName = name => entries.find(entry => entry.name === name);
  const selectedEntries = () => entries.filter(entry => selected.has(entry.name));

  function sortedVisible() {
    const list = filter ? entries.filter(entry => entry.name.toLowerCase().includes(filter)) : [...entries];
    const rank = entry => (entry.type === 'dir' || entry.type === 'link' ? 0 : 1);
    return list.sort((a, b) => rank(a) - rank(b) || FX_COMPARE[sort.key](a, b) * sort.dir || FX_COMPARE.name(a, b));
  }

  // 개발자 모드를 끄면 /sdcard 바로 아래의 Android(data·obb 포함) 시스템 폴더를 숨긴다.
  const visibleEntries = (dir, list) => (state.devMode || dir.replace(/\/+$/, '') !== '/sdcard' ? list : list.filter(entry => entry.name !== 'Android'));

  async function load(keepSelection = false) {
    const token = ++loadToken;
    try {
      const result = await busy(() => api.call('files:list', serial, ds.cwd));
      if (!alive || token !== loadToken) return;
      entries = visibleEntries(ds.cwd, result);
      tree.kids.set(ds.cwd, childDirs(entries));
      if (!keepSelection) { selected.clear(); anchor = cursor = null; }
      else selected = new Set([...selected].filter(name => byName(name)));
      draw();
    } catch (error) {
      if (!alive || token !== loadToken) return;
      entries = [];
      draw();
      statusText.textContent = `${ds.cwd} · 열 수 없음`;
      toast(error.message, 'error');
    }
  }

  function navigate(dir, { record = true } = {}) {
    let next = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
    if (!state.devMode && next !== treeRoot && !next.startsWith(`${treeRoot}/`)) next = treeRoot;
    if (record && next !== ds.cwd) { ds.nav.back.push(ds.cwd); ds.nav.forward = []; }
    ds.cwd = next;
    search.value = filter = '';
    drawLocation();
    load();
  }
  function goBack() {
    const previous = ds.nav.back.pop();
    if (previous == null) return;
    ds.nav.forward.push(ds.cwd);
    navigate(previous, { record: false });
  }
  function goForward() {
    const next = ds.nav.forward.pop();
    if (next == null) return;
    ds.nav.back.push(ds.cwd);
    navigate(next, { record: false });
  }

  // ---- 폴더 트리 (탐색기 탐색 창) ----

  // 기기별로 펼침 상태와 불러온 하위 폴더를 유지해 탭을 오가도 트리가 그대로 남는다.
  const tree = ds.tree ??= { expanded: new Set(['/']), kids: new Map(), loading: new Set() };
  const childDirs = list => list.filter(entry => entry.type === 'dir').map(entry => entry.name).sort((a, b) => FX_COMPARE.name({ name: a }, { name: b }));

  async function loadKids(dir) {
    if (tree.kids.has(dir) || tree.loading.has(dir)) return;
    tree.loading.add(dir);
    try { tree.kids.set(dir, childDirs(visibleEntries(dir, await api.call('files:list', serial, dir)))); } catch { tree.kids.set(dir, []); }
    tree.loading.delete(dir);
    if (alive) drawTree();
  }

  function toggleNode(dir) {
    if (tree.expanded.has(dir)) tree.expanded.delete(dir); else { tree.expanded.add(dir); loadKids(dir); }
    drawTree();
  }

  // 즐겨찾기는 기기별로 저장하고, 트리 루트 위쪽에 폴더로 보여준다.
  const favKey = `fav.${serial}`;
  const favorites = () => fxPrefs.get(favKey, []).filter(dir => typeof dir === 'string' && (dir === treeRoot || dir.startsWith(treeRoot === '/' ? '/' : `${treeRoot}/`)));
  function toggleFavorite(dir) {
    const list = fxPrefs.get(favKey, []);
    fxPrefs.set(favKey, list.includes(dir) ? list.filter(item => item !== dir) : [...list, dir]);
    drawStar();
    drawTree();
  }
  // 글자(★/☆)는 모서리가 뾰족해 보여서, 둥근 모서리의 SVG 별을 쓴다.
  const starSvg = filled => `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z"/></svg>`;
  function drawStar() {
    const on = fxPrefs.get(favKey, []).includes(ds.cwd);
    star.innerHTML = starSvg(on);
    star.classList.toggle('on', on);
    star.title = on ? '즐겨찾기에서 제거' : '즐겨찾기에 추가';
  }

  // 트리의 루트는 연결된 기기 종류(휴대폰/태블릿)에 맞는 아이콘으로 보여준다.
  const nodeIcon = (dir, name) => (dir === treeRoot ? (currentDevice()?.tablet ? 'icons/device-tablet.svg' : 'icons/device-phone.svg') : iconPath({ type: 'dir', name }));

  // 갤럭시 기본 폴더는 즐겨찾기와 무관하게 항상 맨 위에 고정한다. 기기에 실제로 있는 폴더만 보여준다.
  const GALAXY_PINS = [
    { label: '갤러리', icon: 'camera', paths: ['/sdcard/DCIM'] },
    { label: '스크린샷', icon: 'screens', paths: ['/sdcard/DCIM/Screenshots', '/sdcard/Pictures/Screenshots'] },
    { label: '음성 녹음', icon: 'audio', paths: ['/sdcard/Recordings/Voice Recorder', '/sdcard/Voice Recorder'] },
    { label: '다운로드', icon: 'download', paths: ['/sdcard/Download'] },
    { label: '문서', icon: 'docs', paths: ['/sdcard/Documents'] },
    { label: '음악', icon: 'audio', paths: ['/sdcard/Music'] },
  ];
  const insideRoot = dir => dir === treeRoot || dir.startsWith(treeRoot === '/' ? '/' : `${treeRoot}/`);
  function pinnedFolders() {
    const found = [];
    for (const { label, icon, paths } of GALAXY_PINS) {
      for (const path of paths.filter(insideRoot)) {
        const parent = path.slice(0, path.lastIndexOf('/'));
        loadKids(parent);
        if (tree.kids.get(parent)?.includes(path.slice(path.lastIndexOf('/') + 1))) { found.push({ label, icon, path }); break; }
      }
    }
    return found;
  }

  function drawTree() {
    const rows = [];
    const pins = pinnedFolders();
    for (const { label, icon, path } of pins) {
      rows.push(h('div', { class: `fx-tree-row fx-pin-row${path === ds.cwd ? ' active' : ''}`, title: path, dataset: { dropDir: path }, style: 'padding-left:4px', onclick: () => navigate(path) },
        h('span', { class: 'fx-tree-toggle', style: 'visibility:hidden' }),
        h('img', { src: `icons/folders/${icon}.svg`, alt: '', draggable: 'false' }),
        h('span', null, label)));
    }
    if (pins.length) rows.push(h('div', { class: 'fx-tree-sep' }));
    for (const dir of favorites()) {
      rows.push(h('div', { class: `fx-tree-row fx-fav-row${dir === ds.cwd ? ' active' : ''}`, title: dir, dataset: { dropDir: dir }, style: 'padding-left:4px', onclick: () => navigate(dir) },
        Object.assign(h('span', { class: 'fx-tree-toggle fx-fav-star' }), { innerHTML: starSvg(true) }),
        h('img', { src: nodeIcon(dir, dir.slice(dir.lastIndexOf('/') + 1)), alt: '', draggable: 'false' }),
        h('span', null, dir === '/' ? '기기' : dir.slice(dir.lastIndexOf('/') + 1)),
        h('button', { class: 'fx-fav-remove', tabindex: -1, title: '즐겨찾기에서 제거', onclick: event => { event.stopPropagation(); toggleFavorite(dir); } }, '✕')));
    }
    // /sdcard 루트는 항상 펼쳐 둔다.
    if (treeRoot !== '/') tree.expanded.add(treeRoot);
    loadKids(treeRoot);
    const walk = (dir, depth) => {
      const kids = tree.kids.get(dir);
      const open = tree.expanded.has(dir);
      const name = dir === '/' ? '기기' : dir.slice(dir.lastIndexOf('/') + 1);
      // 개발자 모드가 꺼진 상태의 루트(/sdcard)는 기기 이름으로 보여준다.
      const label = depth === 0 && treeRoot !== '/' ? deviceName(currentDevice() ?? { serial }) : name;
      rows.push(h('div', {
        class: `fx-tree-row${dir === ds.cwd ? ' active' : ''}`, title: dir, dataset: { dir, dropDir: dir }, style: `padding-left:${depth * 14 + 4}px`,
        onclick: () => navigate(dir),
      },
      Object.assign(h('button', { class: `fx-tree-toggle${open ? ' open' : ''}`, tabindex: -1, 'aria-label': open ? '접기' : '펼치기', style: (kids && !kids.length) || (depth === 0 && treeRoot !== '/') ? 'visibility:hidden' : '', onclick: event => { event.stopPropagation(); toggleNode(dir); } }), { innerHTML: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
      h('img', { src: nodeIcon(dir, dir === '/' ? '' : name), alt: '', draggable: 'false' }),
      h('span', null, label)));
      if (open) for (const kid of kids ?? []) walk(joinRemote(dir, kid), depth + 1);
    };
    walk(treeRoot, 0);
    side.replaceChildren(...rows);
    side.querySelector('.fx-tree-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  // 현재 폴더까지의 상위 폴더를 모두 펼친다.
  function revealCwd() {
    const parts = ds.cwd.split('/').filter(Boolean);
    const chain = ['/', ...parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)];
    for (const dir of chain.slice(0, -1)) { tree.expanded.add(dir); loadKids(dir); }
    drawTree();
  }

  // ---- 그리기 ----

  function drawLocation() {
    // 개발자 모드가 꺼져 있으면 /sdcard 가 경로의 루트이므로 그 아래 부분만 보여준다.
    const base = treeRoot === '/' ? [] : treeRoot.split('/').filter(Boolean);
    const parts = ds.cwd.split('/').filter(Boolean).slice(base.length);
    const crumb = (label, dir) => h('button', { class: 'fx-crumb', dataset: { dropDir: dir }, title: dir, onclick: event => { event.stopPropagation(); navigate(dir); } }, label);
    crumbs.replaceChildren(crumb('기기', treeRoot), ...parts.flatMap((part, index) => [h('span', { class: 'fx-chevron' }, '›'), crumb(part, `${treeRoot === '/' ? '' : treeRoot}/${parts.slice(0, index + 1).join('/')}`)]));
    back.disabled = !ds.nav.back.length;
    forward.disabled = !ds.nav.forward.length;
    up.disabled = ds.cwd === treeRoot;
    drawStar();
    revealCwd();
  }

  function startAddressEdit() {
    pathInput.value = toDisplayPath(ds.cwd);
    crumbs.hidden = true;
    pathInput.hidden = false;
    pathInput.focus();
    pathInput.select();
  }
  function stopAddressEdit() {
    if (pathInput.hidden) return;
    pathInput.hidden = true;
    crumbs.hidden = false;
    scroller.focus({ preventScroll: true });
  }

  function itemNode(entry) {
    const remote = remoteOf(entry);
    const thumb = FX_THUMB_VIEWS.has(viewMode) && entry.type === 'file' && fxPreviewKind(entry.name) === 'image' && entry.size != null;
    const icon = iconPath(entry);
    const image = h('img', { class: 'fx-icon', alt: '', draggable: 'false', decoding: 'async', src: icon });
    if (thumb) {
      image.addEventListener('error', () => { image.src = icon; image.classList.remove('fx-thumb'); delete image.dataset.orient; }, { once: true });
      thumbs.attach(image, entry, remote);
    }
    const cut = fxClipboard?.mode === 'cut' && fxClipboard.serial === serial && fxClipboard.sources.includes(remote);
    return h('div', {
      class: `fx-item${cut ? ' cut' : ''}`,
      role: 'option',
      title: [entry.name, fxTypeLabel(entry), fxSizeLabel(entry), entry.modified].filter(Boolean).join('\n'),
      dataset: entry.type === 'dir' ? { name: entry.name, dropDir: remote } : { name: entry.name },
      ondblclick: () => { cancelRenameTimer(); open(entry); },
    },
    image,
    h('span', { class: 'fx-name' }, entry.name, entry.target ? h('span', { class: 'link-target' }, `→ ${entry.target}`) : null),
    viewMode === 'details' ? [
      h('span', { class: 'fx-cell modified' }, entry.modified),
      h('span', { class: 'fx-cell type' }, fxTypeLabel(entry)),
      h('span', { class: 'fx-cell size' }, fxSizeLabel(entry)),
      h('span', { class: 'fx-cell perm' }, entry.permissions),
    ] : null);
  }

  function draw() {
    shown = sortedVisible();
    scroller.dataset.view = area.dataset.view = viewMode;
    area.style.setProperty('--icon', `${FX_VIEWS.find(([key]) => key === viewMode)[2]}px`);
    head.hidden = viewMode !== 'details';
    for (const cell of head.querySelectorAll('.fx-head-cell[data-key]')) {
      const active = cell.dataset.key === sort.key;
      cell.classList.toggle('active', active);
      cell.dataset.arrow = active ? (sort.dir === 1 ? '▲' : '▼') : '';
    }
    thumbs.reset();
    area.replaceChildren(...shown.map(itemNode));
    if (!shown.length) area.append(entries.length ? fxEmptyState('검색 조건과 일치하는 항목이 없습니다.', true) : fxEmptyState('이 폴더는 비어 있습니다.', false));
    for (const button of viewSwitch.children) button.classList.toggle('active', button.dataset.view === viewMode);
    updateSelection();
  }

  function updateSelection() {
    for (const node of area.children) if (node.dataset.name) node.classList.toggle('selected', selected.has(node.dataset.name));
    const chosen = selectedEntries();
    const bytes = chosen.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size ?? 0 : 0), 0);
    statusText.textContent = `${entries.length}개 항목${chosen.length ? ` · ${chosen.length}개 선택됨${bytes ? ` (${formatBytes(bytes)})` : ''}` : ''}`;
    buttons.cut.disabled = buttons.copy.disabled = buttons.remove.disabled = buttons.download.disabled = !chosen.length;
    buttons.rename.disabled = chosen.length !== 1;
    buttons.paste.disabled = !(fxClipboard && fxClipboard.serial === serial);
    buttons.preview.setAttribute('aria-pressed', String(previewOn));
  }

  function setView(key) { viewMode = key; fxPrefs.set('view', key); draw(); }
  function setSort(key, dir) {
    sort = { key, dir: dir ?? (sort.key === key ? -sort.dir : 1) };
    fxPrefs.set('sort', sort);
    draw();
  }

  // ---- 메뉴 ----

  const below = element => { const rect = element.getBoundingClientRect(); return [rect.left, rect.bottom + 2]; };
  const viewMenu = element => fxMenu(...below(element), FX_VIEWS.map(([key, label]) => ({ label, checked: key === viewMode, action: () => setView(key) })));
  const sortMenu = element => fxMenu(...below(element), [
    ...FX_SORT_KEYS.map(([key, label]) => ({ label, checked: key === sort.key, action: () => setSort(key, sort.dir) })),
    { separator: true },
    { label: '오름차순', checked: sort.dir === 1, action: () => setSort(sort.key, 1) },
    { label: '내림차순', checked: sort.dir === -1, action: () => setSort(sort.key, -1) },
  ]);
  const uploadMenu = element => fxMenu(...below(element), [
    { icon: 'file-up', label: '파일 업로드…', action: () => upload(false) },
    { icon: 'folder-up', label: '폴더 업로드…', action: () => upload(true) },
  ]);

  function contextMenu(event, entry) {
    const many = selected.size > 1;
    const folderTarget = !many && entry && fxIsFolder(entry) ? remoteOf(entry) : ds.cwd;
    const canPaste = Boolean(fxClipboard && fxClipboard.serial === serial);
    if (!entry) {
      return fxMenu(event.clientX, event.clientY, [
        { label: '새로 고침', hint: 'F5', action: () => load(true) },
        { separator: true },
        { label: '붙여넣기', hint: 'Ctrl+V', disabled: !canPaste, action: () => paste() },
        { label: '새 폴더', hint: 'Ctrl+Shift+N', action: () => mkdir() },
        { separator: true },
        { icon: 'file-up', label: '파일 업로드…', action: () => upload(false) },
        { icon: 'folder-up', label: '폴더 업로드…', action: () => upload(true) },
        { separator: true },
        { label: '미리보기 창', checked: previewOn, hint: 'Alt+P', action: () => togglePreview() },
      ]);
    }
    const isFile = !many && !fxIsFolder(entry);
    return fxMenu(event.clientX, event.clientY, [
      { label: fxIsFolder(entry) && !many ? '열기' : '미리보기', hint: 'Enter', disabled: many, action: () => open(entry) },
      ...(isFile && !fxPreviewKind(entry.name) ? [{ label: 'PC에서 열기', action: () => attempt(() => api.call('files:open', serial, remoteOf(entry))) }] : []),
      { separator: true },
      { label: '잘라내기', hint: 'Ctrl+X', action: () => copySelection('cut') },
      { label: '복사', hint: 'Ctrl+C', action: () => copySelection('copy') },
      { label: many || isFile ? '붙여넣기' : '여기에 붙여넣기', hint: 'Ctrl+V', disabled: !canPaste, action: () => paste(folderTarget) },
      { separator: true },
      { label: '이름 바꾸기', hint: 'F2', disabled: many, action: () => rename() },
      { label: '삭제', hint: 'Delete', action: () => remove() },
      { separator: true },
      { label: '다운로드', action: () => download() },
    ]);
  }

  // ---- 선택 ----

  function clickRow(event, entry) {
    if (event.shiftKey && anchor && byName(anchor)) {
      const names = shown.map(item => item.name);
      const [a, b] = [names.indexOf(anchor), names.indexOf(entry.name)].sort((x, y) => x - y);
      if (!event.ctrlKey && !event.metaKey) selected.clear();
      for (const name of names.slice(a, b + 1)) selected.add(name);
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(entry.name)) selected.delete(entry.name); else selected.add(entry.name);
      anchor = entry.name;
    } else {
      selected = new Set([entry.name]);
      anchor = entry.name;
    }
    cursor = entry.name;
    updateSelection();
  }

  const columnCount = () => (viewMode === 'details' || viewMode === 'list' ? 1 : Math.max(1, getComputedStyle(area).gridTemplateColumns.split(' ').length));
  function moveCursor(event) {
    if (!shown.length) return;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const sign = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1;
    let step;
    if (viewMode === 'details') step = horizontal ? 0 : 1;
    else if (viewMode === 'list') step = horizontal ? Math.max(1, Math.floor(scroller.clientHeight / 26)) : 1;
    else step = horizontal ? 1 : columnCount();
    if (!step) return;
    const current = shown.findIndex(entry => entry.name === cursor);
    const index = current < 0 ? (sign > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, current + sign * step));
    const entry = shown[index];
    if (event.shiftKey) clickRow({ shiftKey: true, ctrlKey: false }, entry); else clickRow({}, entry);
    for (const node of area.children) if (node.dataset.name === entry.name) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---- 동작 ----

  async function open(entry) {
    const remote = remoteOf(entry);
    if (entry.type === 'dir') return navigate(remote);
    if (entry.type === 'link' && await api.call('files:isDir', serial, remote).catch(() => false)) return navigate(remote);
    if (entry.type === 'other') return toast('장치 파일이나 소켓은 열 수 없습니다.', 'error');
    const kind = fxPreviewKind(entry.name);
    if (!kind) return toast('이 형식은 미리보기를 지원하지 않습니다. 이미지·오디오·비디오·PDF·텍스트/코드만 미리 볼 수 있습니다.\n(오른쪽 클릭 → "PC에서 열기"로 PC 앱으로 열 수 있어요)');
    previewing = { entry, remote, kind };
    togglePreview(true);
  }

  async function download() {
    const remotes = selectedEntries().map(remoteOf);
    if (!remotes.length) return;
    const folder = await attempt(() => api.call('files:pull', serial, remotes));
    if (folder) toast(`${remotes.length}개 항목을 ${folder}에 저장했습니다.`, 'ok');
  }

  async function upload(folder, locals, dir = ds.cwd) {
    const count = await attempt(() => api.call(folder ? 'files:pushFolder' : 'files:push', serial, dir, locals));
    if (count) { toast(`${count}개 항목을 ${dir}에 업로드했습니다.`, 'ok'); load(true); }
  }

  async function transfer(sources, dir, mode) {
    const verb = mode === 'move' ? '이동' : '복사';
    const done = await attempt(() => api.call('files:transfer', serial, sources, dir, mode));
    if (done === undefined) return;
    if (done === 0) toast('이미 그 폴더에 있는 항목입니다.');
    else toast(`${done}개 항목을 ${dir}(으)로 ${verb}했습니다.`, 'ok');
    if (mode === 'move') forgetPreview(sources);
    load(true);
  }

  function copySelection(mode) {
    const chosen = selectedEntries();
    if (!chosen.length) return;
    fxClipboard = { serial, mode, sources: chosen.map(remoteOf) };
    toast(`${chosen.length}개 항목을 ${mode === 'cut' ? '잘라냈' : '복사했'}습니다. 붙여넣을 폴더에서 Ctrl+V를 누르세요.`);
    draw();
  }

  async function paste(dir = ds.cwd) {
    if (!fxClipboard || fxClipboard.serial !== serial) return;
    const { mode, sources } = fxClipboard;
    if (mode === 'cut') fxClipboard = null;
    await transfer(sources, dir, mode === 'cut' ? 'move' : 'copy');
    draw();
  }

  async function mkdir() {
    const name = await promptDialog('새 폴더', `${ds.cwd} 안에 만들 폴더 이름`);
    if (!name) return;
    if (name.includes('/')) return toast('폴더 이름에 / 를 넣을 수 없습니다.', 'error');
    if (await attempt(() => api.call('files:mkdir', serial, joinRemote(ds.cwd, name))) !== undefined) {
      await load();
      selected = new Set([name]);
      anchor = cursor = name;
      updateSelection();
    }
  }

  // 탐색기처럼 항목 자리에서 바로 이름을 고친다. (F2 / 선택된 항목의 이름을 다시 클릭)
  let renameTimer = 0, renaming = null;
  const cancelRenameTimer = () => { clearTimeout(renameTimer); renameTimer = 0; };

  async function applyRename(entry, name) {
    if (!name || name === entry.name) return;
    if (name.includes('/')) return toast('이름에 / 를 넣을 수 없습니다.', 'error');
    if (entries.some(item => item.name === name)) return toast('같은 이름의 항목이 이미 있습니다.', 'error');
    if (await attempt(() => api.call('files:move', serial, remoteOf(entry), joinRemote(ds.cwd, name))) !== undefined) {
      forgetPreview([remoteOf(entry)]);
      selected = new Set([name]);
      anchor = cursor = name;
      load(true);
    }
  }

  function rename() {
    cancelRenameTimer();
    const [entry] = selectedEntries();
    if (!entry || selected.size !== 1 || renaming) return;
    const node = [...area.children].find(child => child.dataset.name === entry.name);
    const label = node?.querySelector('.fx-name');
    if (!label) return;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const input = h('input', { class: 'fx-name-input', type: 'text', value: entry.name, spellcheck: 'false', autocomplete: 'off' });
    let done = false;
    const finish = commit => {
      if (done) return;
      done = true;
      renaming = null;
      const value = input.value.trim();
      if (input.isConnected) { label.hidden = false; input.remove(); }
      node.classList.remove('renaming');
      scroller.focus({ preventScroll: true });
      if (commit) applyRename(entry, value);
    };
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(input.isConnected));
    for (const type of ['pointerdown', 'dblclick', 'click', 'contextmenu']) input.addEventListener(type, event => event.stopPropagation());
    renaming = { cancel: () => finish(false) };
    node.classList.add('renaming');
    label.hidden = true;
    label.after(input);
    input.focus();
    const dot = entry.type === 'file' ? entry.name.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }

  async function remove(targets = selectedEntries()) {
    if (!targets.length) return;
    const label = targets.length === 1 ? `“${targets[0].name}”` : `${targets.length}개 항목`;
    if (!await confirmDialog('삭제', `${label}을(를) 기기에서 영구 삭제할까요? 폴더는 내용까지 모두 삭제되며 되돌릴 수 없습니다.`, { okLabel: '삭제', danger: true })) return;
    const remotes = targets.map(remoteOf);
    if (await attempt(() => api.call('files:delete', serial, remotes), `${label}을(를) 삭제했습니다.`) !== undefined) {
      forgetPreview(remotes);
      load();
    }
  }

  // ---- 미리보기 창 ----

  function stopMedia() {
    for (const media of previewBody.querySelectorAll('audio, video')) { media.pause(); media.removeAttribute('src'); media.load(); }
  }
  function forgetPreview(remotes) {
    if (previewing && remotes.some(remote => previewing.remote === remote || previewing.remote.startsWith(`${remote}/`))) { previewing = null; drawPreview(); }
  }
  function togglePreview(force) {
    previewOn = force ?? !previewOn;
    fxPrefs.set('preview', previewOn);
    drawPreview();
    updateSelection();
  }

  function drawPreview() {
    pane.hidden = !previewOn;
    paneSplitter.hidden = !previewOn;
    stopMedia();
    previewBody.replaceChildren();
    previewTitle.textContent = previewing ? previewing.entry.name : '미리보기';
    if (!previewOn) return;
    if (!previewing) {
      previewBody.append(h('div', { class: 'fx-preview-empty' }, '이미지·오디오·비디오·PDF·텍스트/코드 파일을 더블클릭하면 여기에서 바로 볼 수 있습니다.'));
      return;
    }
    const { entry, remote, kind } = previewing;
    const src = fxPreviewUrl(serial, remote);
    const failure = h('div', { class: 'fx-preview-error', hidden: true }, '재생하거나 표시할 수 없는 형식입니다. (코덱 미지원이거나 파일을 읽을 수 없습니다)');
    let media;
    if (kind === 'image') {
      media = h('img', { class: 'fx-preview-image', src, alt: entry.name, title: '클릭하면 크게 봅니다', draggable: 'false', onclick: () => { closeLightbox = fxLightbox(src, entry.name); } });
    } else if (kind === 'audio') {
      media = h('div', { class: 'fx-preview-audio' },
        h('img', { src: iconPath(entry), alt: '', draggable: 'false' }),
        h('audio', { controls: true, autoplay: true, src }));
    } else if (kind === 'text') {
      media = h('div', { class: 'fx-preview-code', 'data-wrap': String(fxPrefs.get('wrap', true)) }, h('div', { class: 'fx-preview-loading' }, '불러오는 중…'));
      fxReadText(src, FX_TEXT_MAX_BYTES).then(({ text, truncated }) => {
        if (!media.isConnected) return;
        if (text.includes('\0')) throw new Error('binary');
        media.replaceChildren(text ? hlRender(text, HL_EXT[fxExt(entry.name)]) : h('div', { class: 'fx-preview-loading' }, '(빈 파일)'));
        if (truncated) media.append(h('div', { class: 'fx-preview-note' }, `파일이 커서 앞부분 ${formatBytes(FX_TEXT_MAX_BYTES)}만 표시했습니다.`));
      }).catch(() => {
        if (!media.isConnected) return;
        media.replaceChildren();
        failure.textContent = '텍스트로 표시할 수 없는 파일입니다. (바이너리이거나 파일을 읽을 수 없습니다)';
        failure.hidden = false;
      });
    } else if (kind === 'pdf') {
      media = h('iframe', { class: 'fx-preview-pdf', src, title: entry.name });
    } else {
      media = h('video', { class: 'fx-preview-video', controls: true, autoplay: true, src });
    }
    for (const element of [media, ...media.querySelectorAll('audio')]) element.addEventListener('error', () => { failure.hidden = false; });
    const meta = h('dl', { class: 'kv fx-preview-meta' },
      h('dt', null, '크기'), h('dd', null, fxSizeLabel(entry) || '—'),
      h('dt', null, '수정한 날짜'), h('dd', null, entry.modified),
      h('dt', null, '경로'), h('dd', { class: 'mono' }, remote));
    previewBody.append(h('div', { class: 'fx-preview-stage' }, media, failure), meta,
      h('div', { class: 'actions' },
        ...(kind === 'text' ? [h('button', {
          class: 'button fx-icon-toggle', 'aria-pressed': String(fxPrefs.get('wrap', true)), title: 'Soft wrap (긴 줄 자동 줄바꿈)', 'aria-label': 'Soft wrap',
          onclick: event => {
            const on = !fxPrefs.get('wrap', true);
            fxPrefs.set('wrap', on);
            media.dataset.wrap = String(on);
            event.currentTarget.setAttribute('aria-pressed', String(on));
          },
        }, fxCmdIcon('wrap'))] : []),
        ...(kind === 'pdf' ? [h('button', { class: 'button', onclick: () => { closeLightbox = fxLightbox(src, entry.name, 'pdf'); } }, '전체 화면')] : []),
        h('button', { class: 'button', onclick: async () => { const folder = await attempt(() => api.call('files:pull', serial, [remote])); if (folder) toast(`${folder}에 저장했습니다.`, 'ok'); } }, '다운로드')));
  }

  // ---- 끌어서 옮기기 (앱 내부 이동·복사 / PC 탐색기로 내보내기) ----

  let press = null, drag = null;

  function onPointerDown(event) {
    cancelRenameTimer();
    if (renaming && !event.target.closest('.fx-name-input')) renaming.cancel();
    if (event.button !== 0 || event.target.closest('.fx-head')) return;
    const node = event.target.closest('.fx-item');
    if (!node) {
      if (!event.ctrlKey && !event.shiftKey && selected.size) { selected.clear(); updateSelection(); }
      return;
    }
    const entry = byName(node.dataset.name);
    if (!entry) return;
    const modifier = event.ctrlKey || event.metaKey || event.shiftKey;
    const wasSelected = selected.has(entry.name);
    // 이미 혼자 선택돼 있던 항목의 이름을 다시 누르면, 더블클릭이 아닌 경우에 한해 이름 편집을 시작한다.
    const slow = wasSelected && !modifier && selected.size === 1 && !renaming && Boolean(event.target.closest('.fx-name'));
    if (!wasSelected || modifier) clickRow(event, entry);
    press = { x: event.clientX, y: event.clientY, entry, collapse: wasSelected && !modifier, slow };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', endPress);
    document.addEventListener('keydown', onDragKey, true);
    window.addEventListener('blur', endPress);
  }

  function onPointerMove(event) {
    if (!press) return;
    if (!drag) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 6 || !selected.has(press.entry.name)) return;
      beginDrag();
    }
    moveDrag(event);
  }

  function beginDrag() {
    const dragged = selectedEntries();
    const ghost = h('div', { class: 'fx-ghost' },
      h('img', { src: iconPath(dragged[0]), alt: '', draggable: 'false' }),
      h('span', null, dragged.length === 1 ? dragged[0].name : `${dragged.length}개 항목`),
      h('b'));
    $('.window').append(ghost);
    document.body.classList.add('fx-dragging');
    drag = { entries: dragged, ghost, copy: false, node: null, dir: null, outside: false, ready: null, native: false };
  }

  const exportItems = dragged => dragged.map(entry => ({ remote: remoteOf(entry), size: entry.size, modified: entry.modified }));

  // PC 탐색기로 내보내려면 파일이 PC에 있어야 하므로, 창 가장자리에 다가가거나 벗어날 때 미리 받아 둔다.
  function exportReady() {
    if (drag.ready) return drag.ready;
    const ready = { done: false };
    ready.promise = api.call('files:prepareExport', serial, exportItems(drag.entries)).then(() => {
      ready.done = true;
      if (drag?.ready === ready && drag.outside) startNative();
    }).catch(error => {
      toast(error.message, 'error');
      if (drag?.ready === ready) endPress();
    });
    drag.ready = ready;
    return ready;
  }

  function setTarget(node, dir) {
    if (drag.node !== node) { drag.node?.classList.remove('drop-hover'); node?.classList.add('drop-hover'); }
    drag.node = node;
    drag.dir = dir;
  }

  function moveDrag(event) {
    const { clientX: x, clientY: y } = event;
    drag.copy = event.ctrlKey;
    drag.ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
    const outside = x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
    if (outside || x < 16 || y < 16 || x >= window.innerWidth - 16 || y >= window.innerHeight - 16) exportReady();
    drag.outside = outside;
    drag.ghost.hidden = outside;
    if (outside) {
      setTarget(null, null);
      if (drag.ready.done) startNative(); else hint.textContent = 'PC로 내보낼 항목을 준비하는 중…';
      return;
    }
    hint.textContent = '';
    const node = document.elementFromPoint(x, y)?.closest('[data-drop-dir]') ?? null;
    const dir = node?.dataset.dropDir ?? null;
    const valid = dir && !drag.entries.some(entry => remoteOf(entry) === dir) && (drag.copy || dir !== ds.cwd);
    setTarget(valid ? node : null, valid ? dir : null);
    drag.ghost.querySelector('b').textContent = valid ? (drag.copy ? '＋ 복사' : '→ 이동') : '';
  }

  function startNative() {
    if (!drag || drag.native) return;
    drag.native = true;
    const items = exportItems(drag.entries);
    endPress();
    api.call('files:startExport', serial, items).then(async ({ moved }) => {
      if (!alive || !moved.length) return;
      const choice = await openModal('PC로 내보내기', h('p', null, `탐색기에서 ${moved.length}개 항목이 “이동”된 것으로 보입니다. 기기에 있는 원본도 삭제할까요? 복사로 남겨 두려면 아래 기본값을 그대로 누르세요.`), [
        { label: '이동 (기기에서 원본 삭제)', kind: 'danger', value: 'move' },
        { label: '복사 (원본 유지)', kind: 'primary', primary: true, value: 'copy' },
      ]);
      if (choice === 'move' && await attempt(() => api.call('files:delete', serial, moved), `${moved.length}개 항목을 기기에서 삭제했습니다.`) !== undefined) { forgetPreview(moved); if (alive) load(); }
    }).catch(error => toast(error.message, 'error'));
  }

  function onPointerUp() {
    if (!press) return;
    const finished = drag, clicked = press;
    if (finished) {
      if (finished.dir) transfer(finished.entries.map(remoteOf), finished.dir, finished.copy ? 'copy' : 'move');
      else if (finished.outside && finished.ready && !finished.ready.done) finished.ready.promise.then(() => toast('내보낼 준비가 끝났습니다. 다시 끌어서 놓으세요.', 'ok'));
    } else if (clicked.collapse) {
      selected = new Set([clicked.entry.name]);
      anchor = cursor = clicked.entry.name;
      updateSelection();
      if (clicked.slow) renameTimer = setTimeout(rename, 550);
    }
    endPress();
  }

  function onDragKey(event) { if (event.key === 'Escape') { event.stopPropagation(); endPress(); } }

  function endPress() {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', endPress);
    document.removeEventListener('keydown', onDragKey, true);
    window.removeEventListener('blur', endPress);
    drag?.node?.classList.remove('drop-hover');
    drag?.ghost.remove();
    document.body.classList.remove('fx-dragging');
    hint.textContent = '';
    press = drag = null;
  }

  // ---- PC에서 끌어다 놓기 (업로드) ----

  const hasFiles = event => event.dataTransfer?.types.includes('Files');
  const dropNodeOf = event => event.target.closest?.('[data-drop-dir]') ?? null;
  let hovered = null;
  function showDropTarget(node) {
    if (hovered !== node) { hovered?.classList.remove('drop-hover'); node?.classList.add('drop-hover'); hovered = node; }
    scroller.classList.toggle('dragging', !node);
    scroller.dataset.drop = `여기에 놓으면 ${ds.cwd}(으)로 업로드합니다`;
  }
  function clearDropTarget() { showDropTarget(null); scroller.classList.remove('dragging'); }

  root.addEventListener('dragover', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    showDropTarget(dropNodeOf(event));
  });
  root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) clearDropTarget(); });
  root.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    const dir = dropNodeOf(event)?.dataset.dropDir ?? ds.cwd;
    clearDropTarget();
    const files = [...event.dataTransfer.files];
    if (files.length) upload(false, files.map(api.pathForFile), dir);
  });

  // ---- 입력 ----

  scroller.addEventListener('pointerdown', onPointerDown);
  scroller.addEventListener('pointerdown', () => scroller.focus({ preventScroll: true }));
  scroller.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (event.target.closest('.fx-head')) return;
    const node = event.target.closest('.fx-item');
    const entry = node ? byName(node.dataset.name) : null;
    if (entry && !selected.has(entry.name)) clickRow({}, entry);
    else if (!entry && selected.size) { selected.clear(); updateSelection(); }
    contextMenu(event, entry);
  });

  root.addEventListener('keydown', event => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || document.querySelector('.overlay:not(.leaving), .fx-lightbox:not(.leaving)')) return;
    const ctrl = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
    if (event.target.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) return;
    if (event.altKey && event.key === 'ArrowLeft') goBack();
    else if (event.altKey && event.key === 'ArrowRight') goForward();
    else if (event.altKey && event.key === 'ArrowUp') navigate(parentRemote(ds.cwd));
    else if (event.altKey && key === 'p') togglePreview();
    else if (event.key === 'Backspace') goBack();
    else if (event.key === 'Delete') remove();
    else if (event.key === 'F2') rename();
    else if (event.key === 'F5') load(true);
    else if (event.key === 'F4' || (ctrl && key === 'l')) startAddressEdit();
    else if (ctrl && key === 'f') { search.focus(); search.select(); }
    else if (ctrl && event.shiftKey && key === 'n') mkdir();
    else if (ctrl && key === 'c') copySelection('copy');
    else if (ctrl && key === 'x') copySelection('cut');
    else if (ctrl && key === 'v') paste();
    else if (ctrl && key === 'a') { selected = new Set(shown.map(entry => entry.name)); updateSelection(); }
    else if (event.key === 'Enter' && selected.size === 1) open(selectedEntries()[0]);
    else if (event.key === 'Escape' && selected.size) { selected.clear(); updateSelection(); }
    else if (event.key.startsWith('Arrow') && !ctrl && !event.altKey) moveCursor(event);
    else return;
    event.preventDefault();
  });

  drawLocation();
  drawPreview();
  load();
  queueMicrotask(() => scroller.focus({ preventScroll: true }));
  return () => {
    alive = false;
    cancelRenameTimer();
    thumbs.reset();
    endPress();
    stopMedia();
    closeLightbox?.();
    document.querySelector('.fx-menu')?.remove();
  };
}
