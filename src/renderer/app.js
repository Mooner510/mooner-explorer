'use strict';

const api = window.explorer;
const $ = (selector, root = document) => root.querySelector(selector);

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (typeof value !== 'string' && key in node) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}

// 네이티브 <select> 대신 쓰는 커스텀 드롭다운. 파일 탭의 메뉴(fxMenu)를 재사용하며 value / onchange 를 select 처럼 다룰 수 있다.
function uiSelect(options, { value = options[0][0], onchange, class: className = '' } = {}) {
  const label = h('span', { class: 'ui-select-label' });
  const node = h('button', { type: 'button', class: `input ui-select ${className}`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, label, h('span', { class: 'ui-select-caret', 'aria-hidden': 'true' }));
  let current = value;
  const sync = () => { label.textContent = options.find(([key]) => key === current)?.[1] ?? ''; };
  Object.defineProperty(node, 'value', { get: () => current, set: next => { current = String(next); sync(); } });
  let toggledOff = false;
  const open = () => {
    // 열린 상태에서 트리거를 누르면 fxMenu가 pointerdown 에서 먼저 닫으므로, 이어지는 click 은 다시 열지 않고 무시한다.
    if (toggledOff) { toggledOff = false; return; }
    const box = node.getBoundingClientRect();
    node.setAttribute('aria-expanded', 'true');
    const close = fxMenu(box.left, box.bottom + 4, options.map(([key, text]) => ({
      label: text, checked: key === current,
      action: () => { if (key === current) return; current = key; sync(); onchange?.({ target: node }); },
    })));
    const menu = document.querySelector('.fx-menu');
    menu.style.minWidth = `${box.width}px`;
    menu.querySelector('.fx-menu-item:has(.fx-check:not(:empty))')?.focus();
    const onPointer = event => { toggledOff = node.contains(event.target); };
    document.addEventListener('pointerdown', onPointer, true);
    const observer = new MutationObserver(() => {
      if (menu.isConnected && !menu.classList.contains('leaving')) return;
      node.setAttribute('aria-expanded', 'false');
      observer.disconnect();
      // 클릭이 아닌 경로(바깥 클릭·Esc)로 닫힌 경우에는 플래그가 남지 않게 한다.
      setTimeout(() => { document.removeEventListener('pointerdown', onPointer, true); toggledOff = false; }, 400);
    });
    observer.observe(menu, { attributes: true });
    observer.observe(menu.parentNode, { childList: true });
    return close;
  };
  node.addEventListener('click', open);
  node.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } });
  sync();
  return node;
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400), hh = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}일`, (d || hh) && `${hh}시간`, `${m}분`].filter(Boolean).join(' ');
}

const joinRemote = (dir, name) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
const parentRemote = dir => {
  const trimmed = dir.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  return index <= 0 ? '/' : trimmed.slice(0, index);
};

// ---- feedback ----

// 퇴장 애니메이션(.leaving)을 재생한 뒤 노드를 제거한다. animationend가 오지 않아도 타이머로 정리한다.
function leave(node, ms = 200) {
  if (!node.isConnected || node.classList.contains('leaving')) return node.remove();
  node.classList.add('leaving');
  node.addEventListener('animationend', () => node.remove(), { once: true });
  setTimeout(() => node.remove(), ms + 100);
}

function toast(message, kind = 'info', ms = kind === 'error' ? 7000 : 3500) {
  const node = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(node);
  setTimeout(() => leave(node), ms);
}

let busyCount = 0;
async function busy(task) {
  busyCount++;
  $('#progress').hidden = false;
  try { return await task(); } finally { if (--busyCount === 0) $('#progress').hidden = true; }
}

// Runs an action with the progress bar and reports failures as a toast; returns undefined on failure.
async function attempt(task, success) {
  try {
    const value = await busy(task);
    if (success) toast(typeof success === 'function' ? success(value) : success, 'ok');
    // undefined is reserved for failure so callers can test `!== undefined`.
    return value === undefined ? true : value;
  } catch (error) {
    toast(error.message, 'error');
    return undefined;
  }
}

function openModal(title, body, buttons) {
  return new Promise(resolve => {
    const close = value => { leave(overlay, 160); document.removeEventListener('keydown', onKey, true); resolve(value); };
    const buttonNodes = buttons.map(button => h('button', {
      class: `button ${button.kind ?? ''}`,
      onclick: async () => {
        if (!button.action) return close(button.value ?? null);
        const result = await button.action();
        if (result !== undefined) close(result);
      },
    }, button.label));
    const primary = buttonNodes[buttons.findIndex(button => button.primary)];
    const onKey = event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(null); }
      else if (event.key === 'Enter' && primary && event.target.tagName !== 'TEXTAREA' && event.target.tagName !== 'BUTTON') { event.preventDefault(); primary.click(); }
    };
    const overlay = h('div', { class: 'overlay', onmousedown: event => { if (event.target === overlay) close(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, h('header', null, title), h('div', { class: 'body' }, typeof body === 'function' ? body(close) : body), h('footer', null, buttonNodes)));
    document.addEventListener('keydown', onKey, true);
    $('.window').append(overlay);
    (overlay.querySelector('input') ?? primary)?.focus();
    overlay.querySelector('input')?.select?.();
  });
}

const confirmDialog = (title, message, { okLabel = '확인', danger = false } = {}) =>
  openModal(title, h('p', null, message), [
    { label: '취소', value: false },
    { label: okLabel, kind: danger ? 'danger solid' : 'primary', primary: true, value: true },
  ]).then(Boolean);

function promptDialog(title, label, initial = '') {
  const input = h('input', { class: 'input', value: initial, spellcheck: false });
  return openModal(title, h('label', { class: 'field' }, h('span', null, label), input), [
    { label: '취소', value: null },
    { label: '확인', kind: 'primary', primary: true, action: () => (input.value.trim() ? input.value.trim() : undefined) },
  ]);
}

// ---- app state ----

const state = {
  devices: [],
  serial: null,
  tab: 'overview',
  status: null,
  cleanup: null,
  perDevice: new Map(),
  devMode: false, // 보기 › 개발자 모드로 보기. 꺼지면 파일 탭 트리의 루트가 /sdcard 가 된다.
};

const deviceState = () => {
  if (!state.perDevice.has(state.serial)) state.perDevice.set(state.serial, { cwd: '/sdcard', appKind: 'user', appSort: 'name', shellCwd: '/' });
  return state.perDevice.get(state.serial);
};
const currentDevice = () => state.devices.find(device => device.serial === state.serial) ?? null;
const ready = () => currentDevice()?.state === 'device';

const TABS = [
  ['overview', '개요', renderOverview],
  ['files', '파일', renderFiles],
  ['apps', '앱', renderApps],
  ['screen', '화면', renderScreen],
  ['logcat', '로그캣', renderLogcat],
  ['shell', '셸', renderShell],
];

const STATE_LABEL = { device: '연결됨', unauthorized: '권한 필요', offline: '오프라인', recovery: '리커버리', sideload: '사이드로드', bootloader: '부트로더', 'no permissions': '권한 없음', authorizing: '인증 중' };
const deviceName = device => device.name || device.model || device.serial;
const deviceSubtitle = device => (device.name && device.model) || device.serial;

function renderSidebar() {
  const list = $('#device-list');
  list.replaceChildren();
  if (!state.devices.length) {
    list.append(h('li', { class: 'device-empty' }, '연결된 기기가 없습니다.', h('br'), 'USB 케이블로 연결하거나 “무선 연결”을 사용하세요.'));
  }
  for (const device of state.devices) {
    const badge = device.state === 'device' ? null : h('span', { class: 'badge warn' }, STATE_LABEL[device.state] ?? device.state);
    list.append(h('li', {
      class: `device-item ${device.serial === state.serial ? 'active' : ''}`,
      title: device.serial,
      onclick: () => selectDevice(device.serial),
    },
    h('span', { class: 'kind', 'aria-label': device.wireless ? 'Wi-Fi' : 'USB' }, device.wireless ? '📶' : '🔌'),
    h('span', { class: 'name' }, deviceName(device), badge),
    h('span', { class: 'serial' }, deviceSubtitle(device))));
  }
}

function renderHeader() {
  const device = currentDevice();
  $('#device-title').replaceChildren(device
    ? h('h1', null, h('span', { class: 'name' }, deviceName(device)), h('span', { class: 'meta' }, `${device.serial} · ${device.wireless ? 'Wi-Fi' : 'USB'}`))
    : h('h1', null, h('span', { class: 'name' }, 'Mooner Explorer'), h('span', { class: 'meta' }, '기기를 선택하세요')));
  $('#tabs').replaceChildren(...TABS.map(([id, label]) => h('button', {
    class: 'tab',
    role: 'tab',
    'aria-selected': String(id === state.tab),
    disabled: !ready(),
    onclick: () => { if (state.tab !== id) { state.tab = id; renderView(); } },
  }, label)));
}

function renderView() {
  state.cleanup?.();
  state.cleanup = null;
  renderHeader();
  const view = $('#view');
  view.replaceChildren();
  const device = currentDevice();
  if (!state.status?.adbPath) return view.append(adbMissing());
  if (!device) return view.append(noDevice());
  if (device.state !== 'device') return view.append(deviceNotReady(device));
  const render = TABS.find(([id]) => id === state.tab)[2];
  state.cleanup = render(view, device.serial) ?? null;
}

function adbMissing() {
  return h('div', { class: 'placeholder' },
    h('h2', null, 'adb를 찾을 수 없습니다'),
    h('p', null, 'Android SDK Platform-Tools를 설치하고 PATH에 추가하거나, 설정에서 adb 실행 파일 경로를 직접 지정하세요.'),
    h('button', { class: 'button primary', onclick: openSettings }, '설정 열기'));
}

function noDevice() {
  return h('div', { class: 'placeholder' },
    h('h2', null, 'Android 기기를 연결하세요'),
    h('ol', null,
      h('li', null, '기기의 설정 › 휴대전화 정보에서 “빌드 번호”를 7번 눌러 개발자 옵션을 켭니다.'),
      h('li', null, '개발자 옵션에서 “USB 디버깅”(무선은 “무선 디버깅”)을 켭니다.'),
      h('li', null, 'USB로 연결하고 기기에 뜨는 디버깅 허용 창에서 “허용”을 누릅니다.')),
    h('button', { class: 'button', onclick: openConnect }, '무선으로 연결'));
}

function deviceNotReady(device) {
  const help = {
    unauthorized: '기기 화면에 표시된 “USB 디버깅 허용” 창에서 허용을 누르세요. 창이 보이지 않으면 케이블을 다시 연결하거나 개발자 옵션에서 “USB 디버깅 권한 취소” 후 다시 시도하세요.',
    offline: '기기가 응답하지 않습니다. 케이블을 다시 연결하거나 설정에서 adb 서버를 재시작하세요.',
    'no permissions': 'USB 장치 권한이 없습니다. Linux라면 udev 규칙을 추가해야 합니다.',
  }[device.state] ?? `현재 상태: ${device.state}. 기기가 일반 모드로 부팅되면 사용할 수 있습니다.`;
  return h('div', { class: 'placeholder' }, h('h2', null, STATE_LABEL[device.state] ?? device.state), h('p', null, help),
    device.wireless ? h('button', { class: 'button', onclick: () => disconnectDevice(device.serial) }, '연결 끊기') : null);
}

function selectDevice(serial) {
  if (state.serial === serial) return;
  state.serial = serial;
  renderSidebar();
  renderView();
}

let lastDevicesJson = '';
async function refreshDevices() {
  if (!state.status?.adbPath) return;
  let devices;
  try { devices = await api.call('devices:list'); } catch (error) { devices = []; setAdbStatus(error.message, true); }
  const json = JSON.stringify(devices);
  if (json === lastDevicesJson) return;
  const wasReady = ready(), previous = state.serial;
  lastDevicesJson = json;
  state.devices = devices;
  if (!currentDevice()) state.serial = (devices.find(device => device.state === 'device') ?? devices[0])?.serial ?? null;
  renderSidebar();
  // Re-render only when the selected device appears, disappears or changes readiness, so open tabs keep their state.
  if (previous !== state.serial || wasReady !== ready() || !ready()) renderView();
  else renderHeader();
}

function setAdbStatus(message, error = false) {
  const node = $('#adb-status');
  node.textContent = message;
  node.classList.toggle('error', error);
}

async function refreshStatus() {
  state.status = await api.call('app:status');
  state.devMode = state.status.devMode;
  if (!state.status.adbPath) setAdbStatus('adb를 찾을 수 없습니다.', true);
  else if (state.status.error) setAdbStatus(state.status.error, true);
  else setAdbStatus('');
}

async function disconnectDevice(serial) {
  await attempt(() => api.call('adb:disconnect', serial), '연결을 끊었습니다.');
  refreshDevices();
}

// ---- overview ----

function renderOverview(view, serial) {
  const root = h('div', { class: 'overview' }, h('div', { class: 'placeholder' }, '기기 정보를 불러오는 중…'));
  // 개요 뒤에서 천천히 흐르는 오로라 덩어리와 점 격자
  const backdrop = h('div', { class: 'ov-backdrop', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  view.append(h('div', { class: 'overview-shell' }, backdrop, root));
  spotlight(root);
  let alive = true;
  let effects = [];
  const stopEffects = () => { effects.forEach(stop => stop()); effects = []; };
  const load = async () => {
    try {
      const info = await busy(() => api.call('device:info', serial));
      if (!alive) return;
      stopEffects();
      const monitor = liveMonitor(serial);
      effects.push(monitor.stop);
      root.replaceChildren(...overviewCards(info, serial, load, monitor.card, stop => effects.push(stop)));
    } catch (error) {
      if (alive) root.replaceChildren(h('div', { class: 'placeholder' }, h('h2', null, '정보를 불러오지 못했습니다'), h('p', null, error.message), h('button', { class: 'button', onclick: load }, '다시 시도')));
    }
  };
  load();
  return () => { alive = false; stopEffects(); };
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = value => Math.max(0, Math.min(1, value));

const SVG_NS = 'http://www.w3.org/2000/svg';
let svgIds = 0;
function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) if (value != null) node.setAttribute(key, value);
  node.append(...children.flat().filter(Boolean));
  return node;
}

// 포인터를 따라 카드 배경·테두리에 빛이 번지고, .tilt 카드는 포인터 쪽으로 살짝 기운다.
function spotlight(root) {
  let current = null;
  const reset = card => { card?.style.removeProperty('--rx'); card?.style.removeProperty('--ry'); };
  root.addEventListener('pointermove', event => {
    const card = event.target.closest?.('.overview > .card');
    if (card !== current) { reset(current); current = card; }
    if (!card) return;
    const box = card.getBoundingClientRect();
    const x = event.clientX - box.left, y = event.clientY - box.top;
    card.style.setProperty('--mx', `${x}px`);
    card.style.setProperty('--my', `${y}px`);
    if (card.classList.contains('tilt') && !reducedMotion()) {
      card.style.setProperty('--rx', `${(0.5 - y / box.height) * 7}deg`);
      card.style.setProperty('--ry', `${(x / box.width - 0.5) * 7}deg`);
    }
  });
  root.addEventListener('pointerleave', () => { reset(current); current = null; });
}

// 무작위 글자가 왼쪽부터 차례로 원래 글자로 풀린다.
function scramble(element, duration = 1100) {
  const text = element.textContent;
  if (reducedMotion()) return element;
  const glyphs = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#$%&@*';
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    const settled = Math.floor(t * text.length);
    element.textContent = [...text].map((char, index) => (index < settled || char === ' ' ? char : glyphs[Math.floor(Math.random() * glyphs.length)])).join('');
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return element;
}

// 숫자를 이전 값에서 새 값으로 부드럽게 옮긴다.
function tween(from, to, onStep, duration = 700) {
  if (from == null || reducedMotion()) return onStep(to);
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    onStep(from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// 히어로 배경의 별빛. 천천히 흘러가며 반짝이고, 가끔 별똥별이 지나간다.
function starfield(canvas) {
  const context = canvas.getContext('2d');
  const still = reducedMotion();
  const stars = Array.from({ length: 110 }, () => ({
    x: Math.random(), y: Math.random(), r: Math.random() * 1.1 + 0.25,
    phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 1.8, drift: 0.003 + Math.random() * 0.008,
  }));
  let width = 0, height = 0, frame = 0, last = performance.now(), meteor = null, nextMeteor = last + 2000;
  const draw = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    context.clearRect(0, 0, width, height);
    for (const star of stars) {
      if (!still) star.x = (star.x - star.drift * dt + 1) % 1;
      context.globalAlpha = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin((now / 1000) * star.speed + star.phase));
      context.fillStyle = star.r > 1.1 ? '#ffe3a3' : '#ffffff';
      context.beginPath();
      context.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
      context.fill();
    }
    if (!still && !meteor && now > nextMeteor) meteor = { x: width * (0.35 + Math.random() * 0.65), y: -10, vx: -(320 + Math.random() * 180), vy: 120 + Math.random() * 80 };
    if (meteor) {
      meteor.x += meteor.vx * dt;
      meteor.y += meteor.vy * dt;
      const tailX = meteor.x - meteor.vx * 0.22, tailY = meteor.y - meteor.vy * 0.22;
      const gradient = context.createLinearGradient(meteor.x, meteor.y, tailX, tailY);
      gradient.addColorStop(0, 'rgba(255, 240, 205, 0.95)');
      gradient.addColorStop(1, 'rgba(255, 240, 205, 0)');
      context.globalAlpha = 1;
      context.strokeStyle = gradient;
      context.lineWidth = 1.6;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(meteor.x, meteor.y);
      context.lineTo(tailX, tailY);
      context.stroke();
      if (meteor.y > height + 40 || meteor.x < -120) { meteor = null; nextMeteor = now + 3000 + Math.random() * 5000; }
    }
    context.globalAlpha = 1;
    if (!still) frame = requestAnimationFrame(draw);
  };
  const observer = new ResizeObserver(() => {
    const ratio = devicePixelRatio || 1;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (still) draw(performance.now());
  });
  observer.observe(canvas);
  // 카드 등장 애니메이션과 겹치지 않도록 조금 늦게 시작한다.
  const delay = still ? 0 : setTimeout(() => { last = performance.now(); frame = requestAnimationFrame(draw); }, 900);
  return () => { clearTimeout(delay); cancelAnimationFrame(frame); observer.disconnect(); };
}

// ---- live monitor ----

const HISTORY_LENGTH = 60;
const SAMPLE_INTERVAL = 2000;

// 0(여유) → 1(위험) 비율을 초록 → 노랑 → 주황 → 빨강으로 바꾼다.
function toneColor(badness) {
  const ratio = clamp01(badness);
  return `hsl(${Math.round(145 * (1 - ratio ** 1.4))} 80% ${ratio > 0.35 && ratio < 0.7 ? 55 : 58}%)`;
}

// 텍스트 안의 첫 숫자를 0에서 목표값까지 올라가듯 보여 준다.
function countUp(element, duration = 900) {
  const text = element.textContent;
  const match = text.match(/\d+(\.\d+)?/);
  if (!match || reducedMotion()) return element;
  const target = Number(match[0]), decimals = match[1] ? match[1].length - 1 : 0;
  const start = performance.now();
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    element.textContent = text.replace(match[0], (target * (1 - (1 - t) ** 3)).toFixed(decimals));
    if (t < 1 && element.isConnected !== false) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return element;
}

// Catmull-Rom 곡선을 베지어로 바꿔 점들을 매끈하게 잇는다.
const smoothPath = points => points.map(([x, y], index) => {
  if (!index) return `M${x.toFixed(2)},${y.toFixed(2)}`;
  const [x0, y0] = points[index - 2] ?? points[index - 1], [x1, y1] = points[index - 1], [x3, y3] = points[index + 1] ?? [x, y];
  return `C${(x1 + (x - x0) / 6).toFixed(2)},${(y1 + (y - y0) / 6).toFixed(2)} ${(x - (x3 - x1) / 6).toFixed(2)},${(y - (y3 - y1) / 6).toFixed(2)} ${x.toFixed(2)},${y.toFixed(2)}`;
}).join(' ');

// 빛나는 선 + 그라데이션 영역 차트. 새 샘플이 오면 한 칸 왼쪽으로 미끄러지듯 흐른다.
function createSparkline({ max = 100 } = {}) {
  const id = `spark-${++svgIds}`, step = 100 / (HISTORY_LENGTH - 1);
  const area = svg('path', { class: 'spark-area', fill: `url(#${id})` });
  const line = svg('path', { class: 'spark-line' });
  const group = svg('g', null, area, line);
  const head = h('span', { class: 'spark-head', hidden: true });
  const element = h('div', { class: 'spark' },
    svg('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('defs', null, svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: 0, class: 'spark-stop-top' }), svg('stop', { offset: 1, class: 'spark-stop-bottom' }))),
      group),
    head);
  return {
    element,
    update(values, fresh, limit = max) {
      const recent = values.slice(-HISTORY_LENGTH);
      const points = [];
      recent.forEach((value, index) => { if (value != null) points.push([100 - (recent.length - 1 - index) * step, 97 - clamp01(value / limit) * 92]); });
      head.hidden = !points.length;
      if (!points.length) { line.removeAttribute('d'); area.removeAttribute('d'); return; }
      const path = smoothPath(points);
      line.setAttribute('d', path);
      area.setAttribute('d', `${path} L${points.at(-1)[0]},100 L${points[0][0]},100 Z`);
      head.style.top = `${points.at(-1)[1]}%`;
      if (fresh && points.length > 1 && !reducedMotion()) group.animate([{ transform: `translateX(${step}px)` }, { transform: 'translateX(0)' }], { duration: 800, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    },
  };
}

// Samples CPU / memory / battery temperature every couple of seconds while the overview is open.
// History lives in the per-device state so switching tabs does not blank the charts.
function liveMonitor(serial) {
  const device = deviceState();
  const history = device.history ??= { cpu: [], memory: [], temperature: [], lastCpu: null, samples: 0 };
  const push = (list, value) => { list.push(value); if (list.length > HISTORY_LENGTH) list.shift(); };
  const last = list => list.findLast(value => value != null);
  const makeMetric = (title, format, { max = 100 } = {}) => {
    const value = h('strong', null, '—'), detail = h('span', { class: 'metric-detail' }), stats = h('span', { class: 'metric-stats' });
    const spark = createSparkline({ max });
    const element = h('div', { class: 'metric' }, h('div', { class: 'metric-head' }, h('span', null, title), value), spark.element, h('div', { class: 'metric-foot' }, detail, stats));
    let shown = null;
    return {
      element,
      set(current, tone, detailText, values, fresh) {
        if (current == null) value.textContent = '—';
        else tween(shown, current, number => { value.textContent = format(number); });
        shown = current;
        element.style.setProperty('--tone', tone == null ? 'var(--muted)' : toneColor(tone));
        detail.textContent = detailText;
        const known = values.filter(item => item != null);
        stats.textContent = known.length > 1 ? `최고 ${format(Math.max(...known))} · 평균 ${format(known.reduce((sum, item) => sum + item, 0) / known.length)}` : '';
        spark.update(values, fresh);
      },
    };
  };
  const percent = number => `${number.toFixed(0)}%`;
  const panels = {
    cpu: makeMetric('CPU 사용률', percent),
    memory: makeMetric('메모리', percent),
    temperature: makeMetric('배터리 온도', number => `${number.toFixed(1)} °C`, { max: 60 }),
  };
  const pill = h('span', { class: 'live-pill' }, h('i'), 'LIVE');
  const tick = h('span', { class: 'monitor-tick' });
  const draw = fresh => {
    const cpu = last(history.cpu), memory = last(history.memory), temperature = last(history.temperature);
    panels.cpu.set(cpu, cpu == null ? null : cpu / 100, cpu == null ? '이 기기에서는 CPU 사용률을 읽을 수 없습니다.' : '전체 코어 평균', history.cpu, fresh);
    panels.memory.set(memory, memory == null ? null : memory / 100, history.memoryText ?? '', history.memory, fresh);
    panels.temperature.set(temperature, temperature == null ? null : temperature / 60, history.batteryText ?? '', history.temperature, fresh);
    tick.textContent = `샘플 ${history.samples.toLocaleString()} · ${SAMPLE_INTERVAL / 1000}초 간격`;
    if (fresh && !reducedMotion()) pill.animate([{ boxShadow: '0 0 0 0 rgba(255, 93, 108, 0.55)' }, { boxShadow: '0 0 0 10px rgba(255, 93, 108, 0)' }], { duration: 900, easing: 'ease-out' });
  };
  let alive = true, timer = null, running = false;
  const sample = async () => {
    if (running) return;
    running = true;
    try {
      const stats = await api.call('device:stats', serial);
      if (!alive) return;
      const usage = stats.cpu && history.lastCpu && stats.cpu.total > history.lastCpu.total
        ? Math.min(100, Math.max(0, (1 - (stats.cpu.idle - history.lastCpu.idle) / (stats.cpu.total - history.lastCpu.total)) * 100))
        : null;
      history.lastCpu = stats.cpu;
      history.samples++;
      if (stats.cpu) push(history.cpu, usage);
      if (stats.memory) {
        push(history.memory, stats.memory.used / stats.memory.total * 100);
        history.memoryText = `${formatBytes(stats.memory.used)} 사용 / ${formatBytes(stats.memory.total)}`;
      }
      if (stats.battery?.temperature != null) {
        push(history.temperature, stats.battery.temperature);
        history.batteryText = `배터리 ${Math.round(stats.battery.level)}% · ${stats.battery.status ?? ''}`;
      }
      draw(true);
    } catch { /* 일시적인 adb 오류는 다음 샘플에서 다시 시도 */ }
    finally { running = false; }
  };
  draw(false);
  sample();
  timer = setInterval(sample, SAMPLE_INTERVAL);
  return {
    card: h('div', { class: 'card wide fill monitor' },
      h('div', { class: 'card-head' }, h('h3', null, '실시간 모니터'), pill, tick),
      h('div', { class: 'metrics' }, panels.cpu.element, panels.memory.element, panels.temperature.element)),
    stop() { alive = false; clearInterval(timer); },
  };
}

function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(([, value]) => value != null && value !== '' && value !== false).map(([key, value]) => [h('dt', null, key), h('dd', null, value)]));
}

// 값을 클릭하면 클립보드로 복사되는 kv 목록
function copyableKv(rows) {
  const list = kv(rows);
  list.classList.add('copyable');
  for (const dd of list.querySelectorAll('dd')) {
    dd.title = `${dd.textContent}\n클릭해서 복사`;
    dd.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(dd.textContent); } catch { return toast('클립보드에 복사하지 못했습니다.', 'error'); }
      dd.classList.remove('copied');
      void dd.offsetWidth;
      dd.classList.add('copied');
      toast(`복사했습니다: ${dd.textContent}`, 'ok', 1800);
    });
  }
  return list;
}

const BATTERY_HEALTH = { 2: '양호', 3: '과열', 4: '수명 다함', 5: '과전압', 6: '오류', 7: '저온' };
const BOOT_STATE = { green: '검증됨', yellow: '사용자 키', orange: '잠금 해제됨', red: '검증 실패' };

// 5일 01:19:42 처럼 초 단위까지 보여 준다.
function formatClock(seconds) {
  const d = Math.floor(seconds / 86400), rest = Math.floor(seconds % 86400);
  const time = [Math.floor(rest / 3600), Math.floor((rest % 3600) / 60), rest % 60].map(value => String(value).padStart(2, '0')).join(':');
  return d ? `${d}일 ${time}` : time;
}

function overviewCards(info, serial, reload, monitorCard, onCleanup) {
  const device = currentDevice();
  const battery = info.battery, storage = info.storage, memory = info.memory;
  const percent = battery ? Math.round((battery.level / battery.scale) * 100) : null;
  const charging = battery?.status === '충전 중';
  const wireless = device?.wireless;
  const chip = (text, tone = '') => h('span', { class: `chip ${tone}` }, text);

  const stars = h('canvas', { class: 'hero-stars', 'aria-hidden': 'true' });
  onCleanup(starfield(stars));
  const uptime = info.uptime != null ? chip(`가동 ${formatClock(info.uptime)}`, 'uptime') : null;
  if (uptime) {
    const started = Date.now();
    const timer = setInterval(() => { uptime.textContent = `가동 ${formatClock(info.uptime + (Date.now() - started) / 1000)}`; }, 1000);
    onCleanup(() => clearInterval(timer));
  }
  const batteryTone = percent == null ? 'var(--accent)' : toneColor(1 - percent / 100);
  const art = h('div', { class: `hero-art ${device?.tablet ? 'tablet' : ''} ${charging ? 'charging' : ''}`, style: `--tone:${batteryTone};--level:${percent ?? 0}`, 'aria-hidden': 'true' },
    h('div', { class: 'orbit o1' }), h('div', { class: 'orbit o2' }),
    h('div', { class: 'handset' }, h('div', { class: 'handset-screen' }, h('div', { class: 'handset-fill' }), h('span', null, percent != null ? `${percent}` : '—'))));
  const stat = (label, value) => value && h('div', { class: 'hero-stat' }, h('span', null, label), h('strong', null, value));
  const hero = h('div', { class: 'card wide hero' },
    stars,
    h('div', { class: 'hero-mark', 'aria-hidden': 'true' }, info.model || ''),
    h('div', { class: 'hero-border', 'aria-hidden': 'true' }),
    art,
    h('div', { class: 'hero-main' },
      h('div', { class: 'hero-eyebrow' }, h('i'), `ONLINE · ${wireless ? 'WIRELESS' : 'USB'} LINK`),
      scramble(h('h2', null, info.name || info.model || serial)),
      h('div', { class: 'hero-sub' }, [info.manufacturer, info.model, info.device && `(${info.device})`].filter(Boolean).join(' ')),
      h('div', { class: 'chips' },
        info.androidVersion && chip(`Android ${info.androidVersion} · API ${info.sdk}`),
        chip(wireless ? '무선 ADB' : 'USB', 'accent'),
        info.ip && chip(`Wi-Fi ${info.ip}`),
        uptime)),
    h('div', { class: 'hero-stats' },
      stat('디스플레이', info.resolution && info.resolution.replace('x', ' × ')),
      stat('CPU', info.cpuCores && `${info.cpuCores} 코어`),
      stat('RAM', memory && formatBytes(memory.total)),
      stat('보안 패치', info.securityPatch)),
    h('div', { class: 'hero-actions' },
      h('button', { class: 'button', title: '정보 다시 읽기', onclick: reload }, '⟳ 새로 고침'),
      wireless
        ? h('button', { class: 'button', onclick: () => disconnectDevice(serial) }, '무선 연결 끊기')
        : h('button', {
          class: 'button',
          title: '기기를 TCP 5555 포트로 전환하고 Wi-Fi로 연결합니다. 이후 케이블을 뽑아도 됩니다.',
          onclick: async () => {
            const address = await attempt(() => api.call('device:wireless', serial), value => `${value} 무선 연결됨. 이제 USB 케이블을 분리해도 됩니다.`);
            if (address) refreshDevices();
          },
        }, '무선 ADB로 전환')));

  const ring = ratio => {
    const pct = Math.round(clamp01(ratio) * 100), id = `ring-${++svgIds}`;
    return h('div', { class: 'ring' },
      svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' },
        svg('defs', null, svg('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 1 }, svg('stop', { offset: 0, class: 'stop-a' }), svg('stop', { offset: 1, class: 'stop-b' }))),
        svg('circle', { class: 'ring-ticks', cx: 50, cy: 50, r: 47, pathLength: 120 }),
        svg('circle', { class: 'ring-track', cx: 50, cy: 50, r: 37 }),
        svg('circle', { class: 'ring-value', cx: 50, cy: 50, r: 37, pathLength: 100, stroke: `url(#${id})`, style: `stroke-dashoffset:${100 - pct}` })),
      h('div', { class: 'ring-label' }, countUp(h('strong', null, `${pct}`)), h('small', null, '%')));
  };
  const gauge = ({ title, badge, big, ratio, bad, caption, extra, className = '' }) => h('div', { class: `card span-2 gauge tilt ${className}`, style: `--tone:${toneColor(bad)};--glow:${toneColor(bad)}` },
    h('div', { class: 'gauge-top' },
      h('div', { class: 'gauge-text' }, h('h3', null, title, badge ? h('span', { class: 'gauge-badge' }, badge) : null), countUp(h('div', { class: 'big' }, big))),
      ring(ratio)),
    h('div', { class: 'meter' }, h('span', { style: `width:${clamp01(ratio) * 100}%` })),
    h('div', { class: 'gauge-caption' }, h('span', null, caption), extra ? h('span', null, extra) : null));
  const missing = (title, message) => h('div', { class: 'card span-2' }, h('h3', null, title), h('p', { class: 'hint' }, message));

  const batteryCard = battery
    ? gauge({
      title: '배터리', badge: charging ? '⚡ 충전 중' : null, className: charging ? 'charging' : '',
      big: `${percent}%`, ratio: battery.level / battery.scale, bad: 1 - battery.level / battery.scale,
      caption: [charging ? null : battery.status, battery.powered.length ? battery.powered.join(', ') : null].filter(Boolean).join(' · ') || '배터리 사용 중',
      extra: [battery.temperature != null && `${battery.temperature.toFixed(1)} °C`, battery.voltage != null && `${battery.voltage.toFixed(2)} V`].filter(Boolean).join(' · '),
    })
    : missing('배터리', '배터리 정보를 가져올 수 없습니다.');
  const usedRatio = storage ? storage.used / storage.total : 0;
  const storageCard = storage
    ? gauge({ title: '저장공간 (/data)', big: `${formatBytes(storage.free)} 남음`, ratio: usedRatio, bad: usedRatio, caption: `${formatBytes(storage.used)} 사용 / ${formatBytes(storage.total)}`, extra: `${Math.round(usedRatio * 100)}% 사용` })
    : missing('저장공간 (/data)', '저장공간 정보를 가져올 수 없습니다.');
  const memoryRatio = memory ? memory.used / memory.total : 0;
  const memoryCard = memory
    ? gauge({ title: '메모리 (RAM)', big: `${formatBytes(memory.available)} 여유`, ratio: memoryRatio, bad: memoryRatio, caption: `${formatBytes(memory.used)} 사용 / ${formatBytes(memory.total)}`, extra: `${Math.round(memoryRatio * 100)}% 사용` })
    : missing('메모리 (RAM)', '메모리 정보를 가져올 수 없습니다.');

  const group = (title, hue, rows) => h('div', { class: 'detail-group', style: `--hue:${hue}` }, h('h4', null, h('i'), title), copyableKv(rows));
  const details = h('div', { class: 'card wide details' },
    h('div', { class: 'card-head' }, h('h3', null, '상세 정보'), h('span', { class: 'card-hint' }, '값을 클릭하면 복사됩니다')),
    h('div', { class: 'detail-groups' },
      group('기기', 'var(--accent)', [['이름', info.name], ['제조사', info.manufacturer], ['모델', info.model], ['코드명', info.device], ['시리얼', info.hardwareSerial ?? info.serial]]),
      group('시스템', '#9b7bff', [['Android', info.androidVersion && `${info.androidVersion} (API ${info.sdk})`], ['보안 패치', info.securityPatch], ['빌드', info.build], ['빌드 유형', info.buildType], ['부트 상태', info.bootState && `${BOOT_STATE[info.bootState] ?? info.bootState} (${info.bootState})`]]),
      group('하드웨어', '#2fd9a8', [['SoC', info.soc], ['CPU', info.cpuCores && `${info.cpuCores}코어 · ${info.abi ?? ''}`], ['메모리', memory && formatBytes(memory.total)], ['커널', info.kernel], ['배터리 상태', battery?.health && (BATTERY_HEALTH[battery.health] ?? battery.health)]]),
      group('디스플레이 · 네트워크', '#6cb2ff', [['해상도', info.resolution], ['밀도', info.density && `${info.density} dpi`], ['Wi-Fi IP', info.ip ?? '연결 안 됨'], ['연결 방식', wireless ? '무선 ADB' : 'USB']])));

  const cards = [hero, batteryCard, storageCard, memoryCard, monitorCard, details];
  cards.forEach((card, index) => {
    card.style.setProperty('--i', index);
    card.prepend(h('span', { class: 'spot', 'aria-hidden': 'true' }));
  });
  return cards;
}

function setupDrop(target, onFiles) {
  let depth = 0;
  target.addEventListener('dragenter', event => { if (event.dataTransfer.types.includes('Files')) { depth++; target.classList.add('dragging'); } });
  target.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; target.classList.remove('dragging'); } });
  target.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  target.addEventListener('drop', event => {
    event.preventDefault();
    depth = 0;
    target.classList.remove('dragging');
    const files = [...event.dataTransfer.files];
    if (files.length) onFiles(files);
  });
}

// ---- apps ----

function renderApps(view, serial) {
  const ds = deviceState();
  let packages = [], filter = '', selectedName = null, alive = true, generation = 0, workers = 0;
  const metas = new Map(); // package name → { label, icon } (null when unreadable)
  const rows = new Map(); // package name → row element
  const queue = [];

  const kind = uiSelect([['user', '사용자 앱'], ['system', '시스템 앱'], ['all', '전체']], { value: ds.appKind, onchange: () => { ds.appKind = kind.value; load(); } });
  const sortModes = {
    name: ['이름순 (가나다)', (a, b) => compareName(a, b)],
    nameDesc: ['이름 역순', (a, b) => compareName(b, a)],
    package: ['패키지명순', (a, b) => a.name.localeCompare(b.name)],
    newest: ['최근 설치·업데이트순', (a, b) => (b.modified ?? 0) - (a.modified ?? 0) || compareName(a, b)],
    oldest: ['오래된 설치순', (a, b) => (a.modified ?? Infinity) - (b.modified ?? Infinity) || compareName(a, b)],
    size: ['용량 큰 순', (a, b) => (b.size ?? 0) - (a.size ?? 0) || compareName(a, b)],
    sizeAsc: ['용량 작은 순', (a, b) => (a.size ?? Infinity) - (b.size ?? Infinity) || compareName(a, b)],
  };
  const displayName = item => metas.get(item.name)?.label || item.name;
  const collator = new Intl.Collator(['ko', 'en'], { sensitivity: 'base', numeric: true });
  const compareName = (a, b) => collator.compare(displayName(a), displayName(b));
  const sort = uiSelect(Object.entries(sortModes).map(([key, [label]]) => [key, label]), { value: ds.appSort, onchange: () => { ds.appSort = sort.value; draw(); } });
  const search = h('input', { class: 'input grow', placeholder: '앱 이름 또는 패키지 이름 검색', oninput: () => { filter = search.value.toLowerCase(); draw(); } });
  const list = h('div', { class: 'app-list drop-target', dataset: { drop: 'APK 파일을 놓으면 설치합니다' } });
  const detail = h('div', { class: 'detail' }, h('div', { class: 'placeholder' }, '앱을 선택하세요.'));
  const count = h('span');

  view.append(
    h('div', { class: 'toolbar' }, kind, sort, search,
      h('button', { class: 'button', title: '새로 고침', onclick: () => load() }, '⟳'),
      h('button', { class: 'button primary', onclick: () => install() }, 'APK 설치')),
    h('div', { class: 'split' }, list, detail),
    h('div', { class: 'statusbar' }, count, h('span', null, 'APK 파일을 목록으로 끌어다 놓아도 설치됩니다.')));

  function draw() {
    let shown = filter ? packages.filter(item => item.name.toLowerCase().includes(filter) || metas.get(item.name)?.label?.toLowerCase().includes(filter)) : packages;
    rows.clear();
    observer.disconnect();
    shown = [...shown].sort(sortModes[ds.appSort]?.[1] ?? sortModes.name[1]);
    // 용량 비례: 가장 큰 앱이 100%
    const maxSize = Math.max(0, ...packages.map(item => item.size ?? 0));
    const fillOf = size => (size > 0 && maxSize ? 100 * size / maxSize : 0);
    list.replaceChildren(...shown.map(item => {
      const row = h('div', {
        class: `app-row ${item.name === selectedName ? 'selected' : ''}`,
        style: maxSize ? `--fill:${fillOf(item.size).toFixed(2)}%` : null,
        onclick: () => select(item),
        dataset: { pkg: item.name },
      }, appIcon(item), h('div', { class: 'app-text' },
        h('div', { class: 'app-label' }, h('span', { class: 'app-name' }, metas.get(item.name)?.label || item.name), item.enabled ? null : h('span', { class: 'badge' }, '비활성')),
        h('div', { class: 'sub mono' }, item.name)),
      h('div', { class: 'app-size' }, item.size != null ? formatBytes(item.size) : ''));
      rows.set(item.name, row);
      observer.observe(row);
      return row;
    }));
    if (!shown.length) list.append(h('div', { class: 'placeholder' }, packages.length ? '검색 결과가 없습니다.' : '앱이 없습니다.'));
    count.textContent = `${packages.length}개 앱${filter ? ` · ${shown.length}개 표시` : ''}`;
  }

  // 아이콘과 이름은 APK 안에 있어서 필요할 때 읽는다. 화면에 보이는 행이 대기열 앞으로 온다.
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = queue.findIndex(item => item.name === entry.target.dataset.pkg);
      if (index > 0) queue.unshift(...queue.splice(index, 1));
    }
    pump();
  }, { root: list, rootMargin: '200px' });

  function appIcon(item) {
    const meta = metas.get(item.name), icon = meta?.icon;
    if (icon?.image) return h('img', { class: 'app-icon', src: icon.image, alt: '', draggable: false });
    if (icon?.foreground) return h('div', { class: 'app-icon layered', style: icon.background?.color ? `background:${icon.background.color}` : null },
      icon.background?.image ? h('img', { src: icon.background.image, alt: '', draggable: false }) : null, h('img', { src: icon.foreground, alt: '', draggable: false }));
    return h('div', { class: 'app-icon fallback' }, (meta?.label || item.name).replace(/^[^p{L}p{N}]+/u, '').charAt(0).toUpperCase());
  }

  let redrawTimer = null;
  function pump() {
    while (workers < 6 && queue.length) {
      const item = queue.shift(), mine = generation;
      workers++;
      api.call('apps:meta', serial, item.apk).catch(() => null).then(meta => {
        if (!alive || mine !== generation) return;
        workers--;
        metas.set(item.name, meta);
        const row = rows.get(item.name);
        if (row) {
          row.firstChild.replaceWith(appIcon(item));
          row.querySelector('.app-name').textContent = meta?.label || item.name;
        }
        if (filter || ds.appSort.startsWith('name')) { clearTimeout(redrawTimer); redrawTimer = setTimeout(draw, 400); }
        pump();
      });
    }
  }

  async function load() {
    try {
      const result = await busy(() => api.call('apps:list', serial, ds.appKind));
      if (!alive) return;
      packages = result;
      generation++;
      workers = 0;
      queue.length = 0;
      queue.push(...packages.filter(item => item.apk && !metas.has(item.name)));
      draw();
      pump();
      const current = packages.find(item => item.name === selectedName);
      if (current) select(current); else { selectedName = null; detail.replaceChildren(h('div', { class: 'placeholder' }, '앱을 선택하세요.')); }
    } catch (error) {
      if (alive) toast(error.message, 'error');
    }
  }

  async function select(item) {
    selectedName = item.name;
    for (const row of list.children) row.classList.toggle('selected', row.dataset.pkg === item.name);
    detail.replaceChildren(h('h2', null, metas.get(item.name)?.label || item.name), h('p', { class: 'hint' }, '정보를 불러오는 중…'));
    let info = {};
    try { info = await api.call('apps:info', serial, item.name); } catch (error) { info = { error: error.message }; }
    if (!alive || selectedName !== item.name) return;
    const act = (label, task, message, options = {}) => h('button', {
      class: `button ${options.kind ?? ''}`,
      onclick: async () => {
        if (options.confirm && !await confirmDialog(label, options.confirm, { okLabel: label, danger: true })) return;
        if (await attempt(task, message) !== undefined && options.reload) load();
      },
    }, label);
    // replaceChildren() would print null as text, so the optional nodes go through h().
    const label = metas.get(item.name)?.label;
    detail.replaceChildren(h('div', null,
      h('div', { class: 'app-head' }, appIcon(item), h('div', { class: 'app-text' }, h('h2', null, label || item.name), label ? h('div', { class: 'sub mono' }, item.name) : null)),
      kv([
        ['버전', info.versionName && `${info.versionName} (${info.versionCode})`],
        ['대상 SDK', info.targetSdk && `API ${info.targetSdk}${info.minSdk ? ` · 최소 API ${info.minSdk}` : ''}`],
        ['설치', info.firstInstallTime?.startsWith('1970') ? null : info.firstInstallTime],
        ['업데이트', info.lastUpdateTime],
        ['설치 출처', info.installer && info.installer !== 'null' ? info.installer : null],
        ['상태', item.enabled ? '활성' : '비활성'],
        ['APK', item.apk],
      ]),
      info.error ? h('p', { class: 'hint' }, info.error) : null,
      h('div', { class: 'actions' },
        act('실행', () => api.call('apps:launch', serial, item.name), '앱을 실행했습니다.'),
        act('강제 종료', () => api.call('apps:stop', serial, item.name), '앱을 강제 종료했습니다.'),
        item.apk ? act('APK 추출', () => api.call('apps:extract', serial, item.name, item.apk), file => (file ? `${file}에 저장했습니다.` : '취소했습니다.')) : null,
        act(item.enabled ? '비활성화' : '활성화', () => api.call('apps:setEnabled', serial, item.name, !item.enabled), item.enabled ? '앱을 비활성화했습니다.' : '앱을 활성화했습니다.', { reload: true, confirm: item.enabled ? `${item.name}을(를) 비활성화할까요? 시스템 앱을 비활성화하면 기기 동작에 문제가 생길 수 있습니다.` : null }),
        act('데이터 삭제', () => api.call('apps:clear', serial, item.name), '앱 데이터를 삭제했습니다.', { kind: 'danger', confirm: `${item.name}의 모든 데이터(설정, 계정, 캐시)를 삭제할까요?` }),
        act('제거', () => api.call('apps:uninstall', serial, item.name), '앱을 제거했습니다.', { kind: 'danger', reload: true, confirm: `${item.name}을(를) 기기에서 제거할까요?` }))));
  }

  async function install(files) {
    const results = await attempt(() => api.call('apps:install', serial, files));
    if (!results?.length) return;
    const failed = results.filter(result => !result.ok);
    if (failed.length) toast(failed.map(result => `${result.file}: ${result.error}`).join('\n'), 'error');
    if (results.length > failed.length) toast(`${results.length - failed.length}개 APK를 설치했습니다.`, 'ok');
    load();
  }

  setupDrop(list, files => {
    const apks = files.map(api.pathForFile).filter(file => /\.apk$/i.test(file));
    if (!apks.length) return toast('APK 파일만 설치할 수 있습니다.', 'error');
    install(apks);
  });

  load();
  return () => { alive = false; observer.disconnect(); };
}

// ---- screen ----

const KEYS = [['뒤로', 4], ['홈', 3], ['최근 앱', 187], ['전원', 26], ['볼륨 +', 24], ['볼륨 −', 25], ['화면 켜기', 224], ['메뉴', 82]];
// [값, 이름, 기기 부담, 설명]. 해상도·전송량이 클수록 기기가 화면을 압축하는 일이 늘어난다.
const SCREEN_QUALITY = [
  ['tiny', '절약', '매우 적음', '가장 가볍습니다. 글씨는 흐리지만 조작은 충분합니다.'],
  ['low', '낮음', '적음', '배터리와 발열이 걱정될 때 좋습니다.'],
  ['normal', '보통', '보통', '대부분 이 설정이면 충분합니다. (권장)'],
  ['high', '선명', '조금 많음', '글씨가 또렷합니다.'],
  ['ultra', '매우 선명', '많음', 'FHD 수준입니다. 기기가 따뜻해질 수 있습니다.'],
  ['original', '원본', '매우 많음', '기기 화면 그대로입니다. 짧게 확인할 때만 쓰세요.'],
];
// 화면 갱신 속도 상한. 기기는 화면이 바뀔 때만 영상을 보내므로 가만히 두면 거의 일하지 않는다.
// 기기 해상도보다 작은 단계만 의미가 있다. 절약·낮음·보통·원본은 항상 쓰고, 선명(1600px+)·매우 선명(1920px+)은 기기 화면이 그보다 클 때만 보여 준다.
const QUALITY_NEEDS = { high: 1600, ultra: 1920 };
const qualityFor = longSide => SCREEN_QUALITY.filter(([key]) => !QUALITY_NEEDS[key] || longSide > QUALITY_NEEDS[key]);

// 한눈에 보이는 선택 버튼 묶음. value / setOptions 로 다룬다.
function segmented(options, { value = options[0][0], onchange } = {}) {
  const node = h('div', { class: 'seg', role: 'radiogroup' });
  let current = value;
  const draw = () => node.replaceChildren(...options.map(([key, label, hint]) => h('button', {
    type: 'button', class: 'seg-item', role: 'radio', title: hint, 'aria-checked': String(key === current),
    onclick: () => { if (key === current) return; current = key; draw(); onchange?.(key); },
  }, label)));
  Object.defineProperty(node, 'value', { get: () => current });
  node.setOptions = next => { options = next; if (!options.some(([key]) => key === current)) current = options[0][0]; draw(); };
  draw();
  return node;
}

const SCREEN_FPS = [['15', '15', '아끼는 모드'], ['30', '30', '일반'], ['60', '60', '아주 부드럽게']];

// 기기의 screenrecord(H.264)를 받아 WebCodecs로 디코딩해 실시간으로 보여 준다. 기기 부하를 줄이기 위해
// 화면이 보이지 않을 때는 스트림을 멈추고, 렌더러가 따라가지 못하면 키 프레임까지 프레임을 버린다.
function renderScreen(view, serial) {
  let alive = true, running = false, session = 0, startedAt = 0;
  let info = null, decoder = null, latest = null, drawing = false, needKey = true, configured = null, frames = 0, shown = 0, stamp = 0, lastDraw = 0;
  const canvas = h('canvas', { class: 'screen-canvas' });
  const context = canvas.getContext('2d', { alpha: false });
  const stage = h('div', { class: 'screen-stage', tabindex: 0 }, h('div', { class: 'placeholder' }, '화면을 연결하는 중…'));
  const status = h('span', { class: 'screen-status' });
  const levels = () => SCREEN_QUALITY.map(([key, name, load]) => [key, name, `기기 부담: ${load}`]);
  const quality = segmented(levels().filter(([key]) => !QUALITY_NEEDS[key]), { value: 'normal', onchange: () => { describe(); start(); } });
  const fps = segmented(SCREEN_FPS, { value: '30', onchange: () => describe() });
  const explain = h('p', { class: 'hint' });
  const describe = () => {
    const [, name, load, note] = SCREEN_QUALITY.find(([key]) => key === quality.value);
    explain.textContent = `${name} — 기기 부담 ${load}. ${note}`;
  };
  const text = h('input', { class: 'input', placeholder: '기기로 보낼 텍스트 (영문)', onkeydown: event => { if (event.key === 'Enter') sendText(); } });

  view.append(
    h('div', { class: 'toolbar' },
      h('span', { class: 'seg-label' }, '화질'), quality,
      h('span', { class: 'seg-label' }, '속도(fps)'), fps,
      h('button', { class: 'button', onclick: () => start() }, '다시 연결'),
      h('button', { class: 'button', onclick: save }, '스크린샷 저장'),
      h('span', { class: 'sep' }),
      status),
    h('div', { class: 'screen' }, stage, h('div', { class: 'screen-side' },
      h('div', null, h('h4', null, '버튼'), h('div', { class: 'keypad' }, KEYS.map(([label, code]) => h('button', { class: 'button', onclick: () => send('key', code) }, label)))),
      h('div', null, h('h4', null, '텍스트 입력'), h('div', { class: 'field-row' }, text, h('button', { class: 'button', onclick: sendText }, '보내기'))),
      h('div', null, h('h4', null, '현재 설정'), explain, h('p', { class: 'hint' }, '속도는 PC 화면에 그리는 횟수만 제한합니다(PC 부담↓). 기기 부담은 화질로 정해지며, 화면이 멈춰 있으면 기기도 거의 일하지 않습니다.')),
      h('p', { class: 'hint' }, '화면을 클릭하면 탭, 끌면 스와이프, 마우스 휠로 스크롤합니다. 기기 부하를 줄이려고 이 탭을 벗어나거나 창이 가려지면 스트림이 멈추고, 돌아오면 이어집니다. 화면을 회전했다면 “다시 연결”을 누르세요.'))));

  const unsubscribe = [
    api.on('screen:frame', onFrame),
    api.on('screen:exit', message => {
      if (!alive || !running) return;
      // screenrecord는 한 번에 최대 3분이라 정상 종료는 조용히 이어 붙이고, 곧바로 끝나는 경우만 오류로 본다.
      if (Date.now() - startedAt > 20_000) start();
      else fail(message);
    }),
  ];

  function fail(message) {
    stopStream();
    stage.replaceChildren(h('div', { class: 'placeholder' }, h('h2', null, '화면을 가져오지 못했습니다'), h('p', null, message), h('button', { class: 'button', onclick: () => start() }, '다시 시도')));
  }

  function resetDecoder() {
    latest?.close();
    latest = null;
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    configured = null;
    needKey = true;
  }

  async function start() {
    const mine = ++session;
    stopStream();
    if (!('VideoDecoder' in window)) return fail('이 환경에서는 실시간 화면(WebCodecs)을 사용할 수 없습니다.');
    try {
      const result = await api.call('screen:start', serial, quality.value);
      if (!alive || mine !== session) return;
      info = result;
      // 기기 화면이 작으면 선명 단계가 의미 없으므로 목록에서 뺀다.
      const offered = qualityFor(Math.max(result.width, result.height)).map(([key]) => key);
      quality.setOptions(levels().filter(([key]) => offered.includes(key)));
      describe();
      running = true;
      startedAt = Date.now();
      canvas.width = result.stream.width;
      canvas.height = result.stream.height;
      if (canvas.parentNode !== stage) stage.replaceChildren(canvas);
      fit();
    } catch (error) {
      if (alive && mine === session) fail(error.message);
    }
  }

  function stopStream() {
    running = false;
    api.call('screen:stop').catch(() => {});
    resetDecoder();
  }

  function onFrame({ key, codec, data }) {
    if (!alive || !running) return;
    decoder ??= new VideoDecoder({
      output: frame => { latest?.close(); latest = frame; if (!drawing) { drawing = true; requestAnimationFrame(draw); } },
      error: error => { if (alive && running) fail(`디코딩 오류: ${error.message}`); },
    });
    if (key && codec && configured !== codec) {
      decoder.configure({ codec, optimizeForLatency: true, avc: { format: 'annexb' } });
      configured = codec;
    }
    if (!configured) return;
    // 디코더가 밀리면 지연이 쌓이므로, 다음 키 프레임까지 델타 프레임을 버린다.
    if (decoder.decodeQueueSize > 6) needKey = true;
    if (needKey && !key) return;
    needKey = false;
    try { decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: frames++ * 16_667, data })); } catch { needKey = true; }
  }

  function draw() {
    if (!latest) { drawing = false; return; }
    // 속도 상한: 아직 이르면 다음 프레임에 다시 확인한다. 최신 화면만 남기 때문에 밀리지 않는다.
    const stamped = performance.now();
    if (stamped - lastDraw < 1000 / Number(fps.value) - 2) return void requestAnimationFrame(draw);
    lastDraw = stamped;
    drawing = false;
    if (canvas.width !== latest.displayWidth || canvas.height !== latest.displayHeight) { canvas.width = latest.displayWidth; canvas.height = latest.displayHeight; }
    context.drawImage(latest, 0, 0);
    latest.close();
    latest = null;
    shown++;
    const now = performance.now();
    if (now - stamp >= 1000) {
      status.textContent = info ? `${info.width}×${info.height} · ${Math.round((shown * 1000) / (now - stamp))} fps` : '';
      shown = 0;
      stamp = now;
    }
  }

  // 스테이지에 딱 맞게(잘리지 않게) 기기 비율을 유지한 채 캔버스 크기를 정한다.
  function fit() {
    if (!info) return;
    const style = getComputedStyle(stage);
    const width = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const scale = Math.min(width / info.width, height / info.height);
    if (!(scale > 0)) return;
    canvas.style.width = `${Math.floor(info.width * scale)}px`;
    canvas.style.height = `${Math.floor(info.height * scale)}px`;
  }
  const observer = new ResizeObserver(fit);
  observer.observe(stage);

  const onVisibility = () => { if (document.hidden) { session++; stopStream(); } else if (alive && !running) start(); };
  document.addEventListener('visibilitychange', onVisibility);

  async function send(kind, value) {
    try { await api.call('screen:input', serial, kind, value); } catch (error) { toast(error.message, 'error'); }
  }

  function sendText() {
    if (!text.value) return;
    send('text', text.value);
    text.value = '';
  }

  async function save() {
    const base64 = await attempt(() => busy(() => api.call('screen:capture', serial)));
    if (!base64) return;
    const file = await attempt(() => api.call('screen:save', base64));
    if (file) toast(`${file}에 저장했습니다.`, 'ok');
  }

  // 캔버스 위 포인터 위치를 기기 화면 좌표로 바꾼다.
  const devicePoint = event => {
    const rect = canvas.getBoundingClientRect();
    const unit = (value, min, size) => Math.min(Math.max((value - min) / size, 0), 1);
    return { x: unit(event.clientX, rect.left, rect.width) * info.width, y: unit(event.clientY, rect.top, rect.height) * info.height };
  };
  let touch = null;
  // 기본 커서 대신 터치 위치를 보여 주는 반투명 원(DevTools 기기 모드처럼). 누르는 동안은 작고 진해진다.
  const dot = h('div', { class: 'touch-dot' });
  document.body.append(dot);
  const moveDot = event => { dot.style.transform = `translate(${event.clientX}px, ${event.clientY}px) translate(-50%, -50%)`; };
  canvas.addEventListener('pointerenter', event => { moveDot(event); dot.classList.add('on'); });
  canvas.addEventListener('pointerleave', () => { if (!touch) dot.classList.remove('on'); });
  canvas.addEventListener('pointermove', moveDot);
  canvas.addEventListener('pointerdown', () => dot.classList.add('down'));
  const dotUp = event => { dot.classList.remove('down'); if (!canvas.contains(document.elementFromPoint(event.clientX, event.clientY))) dot.classList.remove('on'); };
  canvas.addEventListener('pointerup', dotUp);
  canvas.addEventListener('pointercancel', dotUp);
  canvas.addEventListener('pointerdown', event => {
    if (!info || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    touch = { ...devicePoint(event), time: Date.now() };
    if (info.motion) send('down', touch);
  });
  canvas.addEventListener('pointermove', event => {
    if (touch && info.motion) send('move', devicePoint(event));
  });
  canvas.addEventListener('pointerup', event => {
    if (!touch) return;
    const end = devicePoint(event);
    if (info.motion) send('up', end);
    else if (Math.hypot(end.x - touch.x, end.y - touch.y) < 12) send('tap', touch);
    else send('swipe', { x1: touch.x, y1: touch.y, x2: end.x, y2: end.y, duration: Math.min(Math.max(Date.now() - touch.time, 100), 2000) });
    touch = null;
  });
  canvas.addEventListener('pointercancel', event => {
    if (touch && info.motion) send('up', devicePoint(event));
    touch = null;
  });

  // 마우스 휠 → 세로 스와이프. 기기에 쌓이지 않도록 0.3초에 한 번만 보낸다.
  let wheelAt = 0;
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const now = Date.now();
    if (!info || now - wheelAt < 300) return;
    wheelAt = now;
    const point = devicePoint(event), distance = info.height * 0.25 * Math.sign(event.deltaY);
    send('swipe', { x1: point.x, y1: point.y, x2: point.x, y2: Math.min(Math.max(point.y - distance, 0), info.height), duration: 250 });
  }, { passive: false });

  describe();
  start();
  return () => {
    alive = false;
    session++;
    stopStream();
    observer.disconnect();
    dot.remove();
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribe.forEach(off => off());
  };
}

// ---- logcat ----

const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
const MAX_LOG = 20000, MAX_ROWS = 3000;

function renderLogcat(view, serial) {
  let entries = [], running = false, minLevel = 'V', filter = '', autoScroll = true;
  const out = h('div', { class: 'console' });
  const toggle = h('button', { class: 'button primary', onclick: () => (running ? stop() : start()) }, '시작');
  const level = uiSelect(LEVELS.map(value => [value, { V: '전체 (Verbose)', D: 'Debug 이상', I: 'Info 이상', W: 'Warn 이상', E: 'Error 이상', F: 'Fatal' }[value]]), { onchange: () => { minLevel = level.value; redraw(); } });
  const search = h('input', { class: 'input grow', placeholder: '태그 · 메시지 · PID 필터', oninput: () => { filter = search.value.toLowerCase(); redraw(); } });
  const scrollBox = h('input', { type: 'checkbox', checked: true, onchange: () => { autoScroll = scrollBox.checked; } });
  const count = h('span');

  view.append(
    h('div', { class: 'toolbar' }, toggle, level, search,
      h('label', { class: 'check' }, scrollBox, '자동 스크롤'),
      h('span', { class: 'sep' }),
      h('button', { class: 'button', onclick: () => { entries = []; redraw(); } }, '화면 지우기'),
      h('button', { class: 'button', title: '기기의 로그 버퍼를 비웁니다', onclick: () => attempt(() => api.call('logcat:clear', serial), '기기 로그 버퍼를 비웠습니다.') }, '버퍼 비우기'),
      h('button', { class: 'button', onclick: save }, '저장')),
    out,
    h('div', { class: 'statusbar' }, count, h('span', null, `최근 ${MAX_LOG.toLocaleString()}줄까지 보관합니다.`)));

  const matches = entry => (LEVELS.indexOf(entry.level) < 0 || LEVELS.indexOf(entry.level) >= LEVELS.indexOf(minLevel))
    && (!filter || `${entry.tag} ${entry.message} ${entry.pid}`.toLowerCase().includes(filter));
  const row = entry => h('div', { class: `log-row lv-${entry.level}` },
    h('span', { class: 't' }, entry.time), h('span', { class: 'p' }, entry.pid), h('span', { class: 'l' }, entry.level), h('span', { class: 'tag', title: entry.tag }, entry.tag), h('span', null, entry.message));

  function redraw() {
    out.replaceChildren(...entries.filter(matches).slice(-MAX_ROWS).map(row));
    updateCount();
    if (autoScroll) out.scrollTop = out.scrollHeight;
  }
  const updateCount = () => { count.textContent = `${entries.length.toLocaleString()}줄${running ? ' · 수신 중' : ''}`; };

  function append(batch) {
    entries.push(...batch);
    if (entries.length > MAX_LOG) entries.splice(0, entries.length - MAX_LOG);
    const rows = batch.filter(matches).map(row);
    out.append(...rows);
    while (out.childElementCount > MAX_ROWS) out.firstElementChild.remove();
    updateCount();
    if (autoScroll) out.scrollTop = out.scrollHeight;
  }

  const offLines = api.on('logcat:lines', append);
  const offExit = api.on('logcat:exit', message => {
    running = false;
    toggle.textContent = '시작';
    updateCount();
    if (message) toast(message, 'error');
  });

  async function start() {
    if (await attempt(() => api.call('logcat:start', serial)) === undefined) return;
    running = true;
    toggle.textContent = '중지';
    updateCount();
  }
  function stop() {
    api.call('logcat:stop');
    running = false;
    toggle.textContent = '시작';
    updateCount();
  }
  async function save() {
    const content = entries.filter(matches).map(entry => (entry.time ? `${entry.time} ${entry.pid.padStart(5)} ${entry.tid.padStart(5)} ${entry.level} ${entry.tag}: ${entry.message}` : entry.message)).join('\n');
    const file = await attempt(() => api.call('logcat:save', content));
    if (file) toast(`${file}에 저장했습니다.`, 'ok');
  }

  start();
  return () => { offLines(); offExit(); if (running) api.call('logcat:stop'); };
}

// ---- shell ----

const SHELL_MARKER = '__MOONER_PWD__';
const SHELL_SNIPPETS = ['ls -la', 'pm list packages -3', 'dumpsys battery', 'ps -A', 'top -b -n 1 | head -20', 'getprop ro.build.fingerprint', 'settings list global'];
const shellHistory = [];

function renderShell(view, serial) {
  const ds = deviceState();
  let alive = true, running = false, historyIndex = shellHistory.length;
  const out = h('div', { class: 'console' });
  const prompt = h('span', { class: 'prompt' });
  const input = h('input', { class: 'input mono grow', placeholder: '명령어 입력 후 Enter (예: ls -la, pm list packages)', spellcheck: false, onkeydown: onKey });
  const runButton = h('button', { class: 'button primary', onclick: () => (running ? api.call('shell:cancel') : run()) }, '실행');

  view.append(
    h('div', { class: 'toolbar' }, h('div', { class: 'chips' }, SHELL_SNIPPETS.map(snippet => h('button', { class: 'chip', onclick: () => { input.value = snippet; input.focus(); } }, snippet))),
      h('button', { class: 'button', onclick: () => out.replaceChildren() }, '지우기')),
    out,
    h('div', { class: 'shell-input' }, prompt, input, runButton));
  const updatePrompt = () => { prompt.textContent = `${ds.shellCwd} $`; prompt.title = ds.shellCwd; };
  updatePrompt();
  out.append(h('pre', { class: 'shell-out shell-meta' }, 'adb shell 명령을 한 번에 하나씩 실행합니다. cd로 이동한 폴더는 다음 명령에도 유지됩니다.\n대화형 명령(vi, top 등 화면을 계속 갱신하는 명령)은 지원하지 않으며, 오래 걸리는 명령은 “중지”로 취소할 수 있습니다.'));

  function onKey(event) {
    if (event.key === 'Enter') run();
    else if (event.key === 'ArrowUp' && historyIndex > 0) { input.value = shellHistory[--historyIndex]; event.preventDefault(); }
    else if (event.key === 'ArrowDown') { historyIndex = Math.min(historyIndex + 1, shellHistory.length); input.value = shellHistory[historyIndex] ?? ''; event.preventDefault(); }
  }

  const print = (textValue, cls) => { if (textValue) out.append(h('pre', { class: `shell-out ${cls ?? ''}` }, textValue)); out.scrollTop = out.scrollHeight; };

  async function run() {
    const command = input.value.trim();
    if (!command || running) return;
    if (shellHistory.at(-1) !== command) shellHistory.push(command);
    historyIndex = shellHistory.length;
    input.value = '';
    print(`${ds.shellCwd} $ ${command}`, 'shell-cmd');
    running = true;
    runButton.textContent = '중지';
    const quoted = `'${ds.shellCwd.replace(/'/g, `'\\''`)}'`;
    const wrapped = `cd ${quoted} 2>/dev/null || cd /; ${command}\n__mooner_code=$?; printf '\\n${SHELL_MARKER}%s' "$(pwd)"; exit $__mooner_code`;
    try {
      const result = await api.call('shell:run', serial, wrapped);
      if (!alive) return;
      let stdout = result.stdout;
      const index = stdout.lastIndexOf(`\n${SHELL_MARKER}`);
      if (index >= 0) {
        ds.shellCwd = stdout.slice(index + SHELL_MARKER.length + 1).trim() || ds.shellCwd;
        stdout = stdout.slice(0, index);
        updatePrompt();
      }
      print(stdout.replace(/\n$/, ''));
      print(result.stderr.replace(/\n$/, ''), 'shell-err');
      if (result.code !== 0) print(`(종료 코드 ${result.code})`, 'shell-meta');
    } catch (error) {
      if (alive) print(error.message, 'shell-err');
    } finally {
      running = false;
      runButton.textContent = '실행';
      if (alive) input.focus();
    }
  }

  setTimeout(() => input.focus());
  return () => { alive = false; if (running) api.call('shell:cancel'); };
}

// ---- dialogs ----

async function openConnect() {
  const address = h('input', { class: 'input mono', placeholder: '192.168.0.10:5555', spellcheck: false });
  const pairAddress = h('input', { class: 'input mono', placeholder: '192.168.0.10:37123', spellcheck: false });
  const pairCode = h('input', { class: 'input mono', placeholder: '6자리 코드', spellcheck: false, inputmode: 'numeric', style: 'max-width:120px' });
  const connect = async target => {
    if (!target) return toast('주소를 입력하세요.', 'error');
    const message = await attempt(() => api.call('adb:connect', target));
    if (message) { toast(message, 'ok'); refreshDevices(); }
    return message;
  };
  // QR 페어링: 기기가 QR을 스캔할 때까지 main이 mDNS를 폴링하므로 busy 표시줄 없이 직접 호출한다.
  const qrBox = h('div', { class: 'qr-box' });
  const qrButton = h('button', { class: 'button' }, 'QR 코드 표시');
  let qrActive = false;
  const stopQr = () => { if (qrActive) { qrActive = false; api.call('adb:qrCancel').catch(() => {}); } };
  const startQr = async close => {
    stopQr();
    qrButton.disabled = true;
    try {
      const { svg } = await api.call('adb:qrStart');
      qrActive = true;
      qrBox.replaceChildren(
        h('img', { class: 'qr-image', alt: '무선 디버깅 페어링 QR 코드', width: 220, height: 220, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` }),
        h('p', null, '기기의 개발자 옵션 › 무선 디버깅 › “QR 코드로 기기 페어링”에서 이 코드를 스캔하세요. (PC와 같은 Wi-Fi 필요)'));
      const result = await api.call('adb:qrWait');
      qrActive = false;
      if (result.address) toast(`QR 페어링 후 연결됨: ${result.address}`, 'ok');
      else toast('페어링되었습니다. 기기가 곧 자동으로 연결되지 않으면 무선 디버깅 화면의 IP 주소와 포트로 연결하세요.', 'ok');
      refreshDevices();
      close(true);
    } catch (error) {
      const cancelled = !qrActive && error.message.includes('취소');
      qrActive = false;
      qrBox.replaceChildren();
      if (!cancelled) toast(error.message, 'error');
    } finally {
      qrButton.disabled = false;
    }
  };
  await openModal('무선 연결', close => [
    h('label', { class: 'field' }, h('span', null, 'QR 코드로 페어링 (Android 11 이상)'),
      h('div', { class: 'field-row' }, Object.assign(qrButton, { onclick: () => startQr(close) }))),
    qrBox,
    h('hr', { class: 'divider' }),
    h('label', { class: 'field' }, h('span', null, 'IP 주소로 연결 (기기에서 무선 디버깅이 켜져 있어야 합니다)'),
      h('div', { class: 'field-row' }, address, h('button', { class: 'button primary', onclick: async () => { if (await connect(address.value.trim())) close(true); } }, '연결'))),
    h('hr', { class: 'divider' }),
    h('p', null, 'Android 11 이상: 기기의 개발자 옵션 › 무선 디버깅 › “페어링 코드로 기기 페어링”에 표시된 IP 주소와 포트, 코드를 입력하세요. 페어링 후에는 무선 디버깅 화면 상단의 “IP 주소 및 포트”로 연결합니다.'),
    h('label', { class: 'field' }, h('span', null, '페어링'),
      h('div', { class: 'field-row' }, pairAddress, pairCode, h('button', {
        class: 'button',
        onclick: async () => {
          if (!pairAddress.value.trim() || !pairCode.value.trim()) return toast('페어링 주소와 코드를 입력하세요.', 'error');
          const message = await attempt(() => api.call('adb:pair', pairAddress.value, pairCode.value));
          if (message) { toast(message, 'ok'); address.value = `${pairAddress.value.trim().split(':')[0]}:`; address.focus(); }
        },
      }, '페어링'))),
    h('p', null, 'USB로 연결된 기기라면 개요 탭의 “무선 ADB로 전환”을 사용하는 것이 가장 간단합니다.'),
  ], [{ label: '닫기', value: null }]);
  stopQr();
}

async function openSettings() {
  await refreshStatus().catch(() => {});
  const status = state.status ?? {};
  const pathInput = h('input', { class: 'input mono', value: status.customAdbPath ?? '', placeholder: status.adbPath ? `자동 감지: ${status.adbPath}` : '자동 감지 실패', spellcheck: false });
  await openModal('설정', [
    h('label', { class: 'field' }, h('span', null, 'adb 실행 파일 경로 (비워 두면 ADB_PATH, ANDROID_HOME, 기본 SDK 위치, PATH 순서로 찾습니다)'),
      h('div', { class: 'field-row' }, pathInput, h('button', {
        class: 'button',
        onclick: async () => { const file = await api.call('settings:pickAdb'); if (file) pathInput.value = file; },
      }, '찾아보기'))),
    kv([
      ['사용 중인 adb', status.adbPath ?? '없음'],
      ['adb 버전', status.adbVersion ?? '—'],
      ['앱 버전', status.appVersion],
    ]),
    h('div', { class: 'actions' }, h('button', {
      class: 'button',
      onclick: async () => { if (await attempt(() => api.call('adb:restart'), 'adb 서버를 재시작했습니다.') !== undefined) { lastDevicesJson = ''; refreshDevices(); } },
    }, 'adb 서버 재시작')),
  ], [
    { label: '닫기', value: null },
    {
      label: '저장',
      kind: 'primary',
      primary: true,
      action: async () => {
        try {
          state.status = await api.call('settings:setAdbPath', pathInput.value.trim() || null);
          await refreshStatus();
          lastDevicesJson = '';
          await refreshDevices();
          renderView();
          toast('설정을 저장했습니다.', 'ok');
          return true;
        } catch (error) {
          toast(error.message, 'error');
          return undefined;
        }
      },
    },
  ]);
}

// ---- boot ----

$('#refresh-devices').addEventListener('click', () => { lastDevicesJson = ''; refreshDevices(); });
function setSidebarCollapsed(collapsed) {
  $('.app').classList.toggle('sidebar-collapsed', collapsed);
  $('#toggle-sidebar').setAttribute('aria-expanded', String(!collapsed));
  try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch { /* storage unavailable */ }
}
$('#toggle-sidebar').addEventListener('click', () => setSidebarCollapsed(!$('.app').classList.contains('sidebar-collapsed')));
try { if (localStorage.getItem('sidebarCollapsed') === '0') setSidebarCollapsed(false); } catch { /* storage unavailable */ }
api.on('view:devMode', enabled => {
  state.devMode = enabled;
  if (state.tab === 'files') renderView();
});
$('#open-connect').addEventListener('click', openConnect);
$('#open-settings').addEventListener('click', openSettings);
// Dropping files anywhere else would navigate the window away from the app.
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => event.preventDefault());

(async () => {
  try { await refreshStatus(); } catch (error) { setAdbStatus(error.message, true); }
  renderSidebar();
  renderView();
  await refreshDevices();
  setInterval(refreshDevices, 2000);
})();
