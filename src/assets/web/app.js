/* ==========================================================================
   局域网文件浏览器 · 前端逻辑
   - 路由：/  首页位置     /d/<base64路径>  目录     ?open=<base64文件>  打开文件
   - 图片看器：滑动切换、双指缩放、双击放大、保存原图
   - 文本阅读器：自动编码、字号调节
   - 音视频：原生播放器（后端支持 Range）
   ========================================================================== */
'use strict';

/* ------------------------------- 工具 ------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ICON = {
  dir: 'i-folder', image: 'i-image', text: 'i-text', video: 'i-video',
  audio: 'i-audio', pdf: 'i-file', file: 'i-file',
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

/* base64url（UTF-8 安全） */
function b64e(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(str) {
  if (!str) return '';
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) { return ''; }
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0)) + ' ' + units[i];
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function joinPath(dir, name) {
  if (!dir) return name;
  return /[\\/]$/.test(dir) ? dir + name : dir + '\\' + name;
}
function dirname(p) {
  return String(p).replace(/[\\/][^\\/]+$/, '');
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* ------------------------------- API ------------------------------- */
async function api(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (e) { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const dirApi = (path, sort, order) =>
  api('fapi/list?p=' + encodeURIComponent(b64e(path)) +
      '&sort=' + encodeURIComponent(sort) + '&order=' + encodeURIComponent(order));

const textApi = (path) => api('fapi/text?p=' + encodeURIComponent(b64e(path)));
const infoApi = (path) => api('fapi/info?p=' + encodeURIComponent(b64e(path)));
const searchApi = (path, q) =>
  api('fapi/search?p=' + encodeURIComponent(b64e(path)) + '&q=' + encodeURIComponent(q));

const thumbUrl = (path, mtime, size = 400) =>
  'thumb?p=' + encodeURIComponent(b64e(path)) + '&s=' + size + (mtime ? '&v=' + mtime : '');
const viewUrl = (path, mtime, w = 1800) =>
  'view?p=' + encodeURIComponent(b64e(path)) + '&w=' + w + (mtime ? '&v=' + mtime : '');
const rawUrl = (path, mtime) =>
  'raw?p=' + encodeURIComponent(b64e(path)) + (mtime ? '&v=' + mtime : '');
const downloadUrl = (path) => 'download?p=' + encodeURIComponent(b64e(path));

/* ------------------------------- 状态 ------------------------------- */
const S = {
  locations: null,
  server: null,
  dir: '',
  dirData: null,
  items: [],
  images: [],
  view: localStorage.getItem('lfb.view') || 'grid',
  sort: localStorage.getItem('lfb.sort') || 'name',
  order: localStorage.getItem('lfb.order') || 'asc',
  overlay: null,
  searchMode: false,
  cache: new Map(),
};

let renderList = [];
let renderedCount = 0;
const PAGE = 240;

/* ------------------------------ 主题 ------------------------------ */
function applyTheme() {
  const q = new URLSearchParams(location.search).get('theme');
  const saved = localStorage.getItem('lfb.theme');
  const sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const theme = (q === 'light' || q === 'dark') ? q : (saved || sys);
  document.documentElement.dataset.theme = theme;
}
function themeIcon() {
  return document.documentElement.dataset.theme === 'light' ? 'i-moon' : 'i-sun';
}
function themeLabel() {
  return document.documentElement.dataset.theme === 'light' ? '切换深色' : '切换浅色';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('lfb.theme', next);
  const btn = $('#btnTheme');
  if (btn) {
    btn.innerHTML = '<svg class="ic"><use href="#' + themeIcon() + '"/></svg><span>' + themeLabel() + '</span>';
  }
}

/* ------------------------------ 小部件 ------------------------------ */
let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function setLoading(on) {
  $('#app').classList.toggle('is-loading', on);
}

function showView(name) {
  ['locView', 'fileView', 'resultView'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = (id !== name);
  });
}

function scrollTop() {
  const main = $('#main');
  if (main) main.scrollTop = 0;
}

function download(item) {
  const a = document.createElement('a');
  a.href = downloadUrl(item.path);
  a.download = item.name || 'file';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 100);
  toast('开始下载：' + (item.name || ''));
}

/* ------------------------------ 路由 ------------------------------ */
const DIR_PREFIX = '#/d/';
const dirUrl = (path) => DIR_PREFIX + b64e(path);
const openUrl = (dir, file) => dirUrl(dir) + '?open=' + b64e(file);

function parseUrl() {
  const hash = location.hash || '';
  const m = hash.match(/^#\/d\/([^?]+)(?:\?(.*))?$/);
  if (!m) return { dir: null, open: null };
  const params = new URLSearchParams(m[2] || '');
  return {
    dir: b64d(m[1]),
    open: params.get('open') ? b64d(params.get('open')) : null,
  };
}

let applyingUrl = false;
async function applyUrl() {
  if (applyingUrl) return;
  applyingUrl = true;
  try {
    const st = parseUrl();
    if (!st.dir) {
      closeOverlays();
      await showLocations(false);
      return;
    }
    if (st.dir !== S.dir || !S.dirData) {
      const ok = await openDir(st.dir, { history: 'none' });
      if (!ok) { await showLocations(false); return; }
    } else {
      closeOverlays();
    }
    if (st.open) {
      const item = S.items.find((x) => x.path === st.open);
      if (item) openItem(item, { push: false });
      else openFileByPath(st.open, { push: false });
    }
  } finally {
    applyingUrl = false;
  }
}

/* ------------------------------ 首页 ------------------------------ */
async function showLocations(pushHistory) {
  closeOverlays();
  exitSearch(false);
  S.dir = '';
  S.dirData = null;
  S.items = [];
  S.images = [];
  updateTopbar({ home: true });

  setLoading(true);
  try {
    const data = await api('fapi/locations');
    S.locations = data;
    S.server = data.server || {};
    const server = S.server || {};
    setTitle('局域网文件', (server.hostname || '本机') +
      (server.ips && server.ips[0] ? ' · ' + server.ips[0] : '') + ' · 只读');
    renderLocations(data);
    showView('locView');
    scrollTop();
    if (pushHistory) history.pushState({}, '', '#/');
    else history.replaceState({}, '', '#/');
  } catch (err) {
    renderConnectError(err);
    showView('locView');
  } finally {
    setLoading(false);
  }
}

function renderConnectError(err) {
  const view = $('#locView');
  view.innerHTML =
    '<div class="empty">' +
    '<svg class="ic"><use href="#i-close"/></svg>' +
    '<div>无法连接电脑上的服务</div>' +
    '<div style="margin-top:6px;opacity:.7">' + esc(err.message) + '</div>' +
    '<div style="margin-top:20px"><button class="ghost-btn" id="btnRetry">' +
    '<svg class="ic"><use href="#i-refresh"/></svg><span>重试</span></button></div>' +
    '</div>';
  const btn = $('#btnRetry');
  if (btn) btn.addEventListener('click', () => showLocations(false));
}

function locIcon(icon) {
  return {
    desktop: 'i-desktop', image: 'i-image', download: 'i-download', doc: 'i-doc',
    video: 'i-video', audio: 'i-audio', chat: 'i-chat', drive: 'i-drive',
  }[icon] || 'i-folder';
}

function locCard(it) {
  const isDrive = it.kind === 'drive';
  let meter = '';
  if (isDrive && it.total) {
    const pct = clamp(((it.total - it.free) / it.total) * 100, 0, 100);
    meter =
      '<div class="loc-meter"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="loc-cap">' + fmtSize(it.free) + ' 可用 · 共 ' + fmtSize(it.total) + '</div>';
  }
  return (
    '<button class="loc" data-path="' + esc(it.path) + '">' +
    '<div class="loc-top">' +
    '<span class="loc-ic ' + esc(it.icon) + '"><svg class="ic"><use href="#' + locIcon(it.icon) + '"/></svg></span>' +
    '<span class="loc-name">' + esc(it.name) + '</span>' +
    '</div>' +
    '<div class="loc-sub">' + esc(it.path) + '</div>' +
    meter +
    '</button>'
  );
}

function renderLocations(data) {
  const locs = data.locations || [];
  const drives = data.drives || [];
  const server = data.server || {};

  let html =
    '<div class="hero"><h1>这台电脑</h1>' +
    '<p>浏览照片、文本、视频和任何文件 · 完全只读</p></div>';

  const lanUrl = server.lan_url || '';
  const qrTarget = location.origin + '/files/';
  const showQr = !isMobile && lanUrl;
  if (showQr) {
    html +=
      '<div class="qr-card">' +
      '<div class="qr-head"><svg class="ic"><use href="#i-qr"/></svg>用手机扫一扫，直接打开</div>' +
      '<div class="qr-box"><img src="qr.svg?text=' + encodeURIComponent(qrTarget) + '" alt="二维码"></div>' +
      '<div class="qr-url">' + esc(lanUrl.replace(/\/$/, '')) + '</div>' +
      '<div class="qr-tip">手机需连接与电脑相同的 Wi-Fi / 路由器</div>' +
      '</div>';
  }

  const aiUrl = '/';
  const aiOn = !!server.ai_available;
  if (aiUrl) {
    html +=
      '<div class="sec-title">AI 助手</div>' +
      '<div class="ai-card ' + (aiOn ? '' : 'off') + '" data-url="' + esc(aiUrl) + '">' +
      '<span class="ai-ic"><svg class="ic"><use href="#i-chat"/></svg></span>' +
      '<div class="ai-main">' +
      '<div class="ai-name">DeepSeek Harness</div>' +
      '<div class="ai-sub">' + (aiOn
        ? '在手机上继续和 AI 对话、安排工作'
        : '未启动 · 双击「启动-AI手机版.bat」') + '</div>' +
      '</div>' +
      (showQr && aiOn
        ? '<img class="ai-qr" src="qr.svg?text=' + encodeURIComponent(aiUrl) + '" alt="二维码">'
        : '<svg class="ic ai-arrow"><use href="#i-chevron"/></svg>') +
      '</div>';
  }

  if (locs.length) {
    html += '<div class="sec-title">常用位置</div><div class="loc-grid">';
    for (const it of locs) html += locCard(it);
    html += '</div>';
  }
  if (drives.length) {
    html += '<div class="sec-title">此电脑</div><div class="loc-grid">';
    for (const it of drives) html += locCard(it);
    html += '</div>';
  }

  html +=
    '<div class="foot">' +
    '<div class="btn-row"><button class="ghost-btn" id="btnTheme">' +
    '<svg class="ic"><use href="#' + themeIcon() + '"/></svg><span>' + themeLabel() + '</span></button></div>' +
    '<div>' + esc(server.hostname || '本机') +
    (server.ips && server.ips[0] ? ' · ' + esc(server.ips[0]) : '') +
    ' · v' + esc(server.version || '') + '</div>' +
    '<div>手机与电脑需在同一局域网 · 只读访问，安全放心</div>' +
    '</div>';

  const view = $('#locView');
  view.innerHTML = html;
  view.querySelectorAll('.loc[data-path]').forEach((el) => {
    el.addEventListener('click', () => openDir(el.dataset.path, { push: true }));
  });
  view.querySelectorAll('.ai-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('off')) {
        toast('AI 助手未启动：请在电脑上双击「启动-AI手机版.bat」', 3600);
        return;
      }
      location.href = el.dataset.url;
    });
  });
  const btnTheme = $('#btnTheme');
  if (btnTheme) btnTheme.addEventListener('click', toggleTheme);
}

/* ------------------------------ 顶栏 / 面包屑 ------------------------------ */
function updateTopbar(opt = {}) {
  const home = !!opt.home;
  $('#btnBack').hidden = home;
  $('#btnSearch').hidden = home || !!opt.noSearch;
  $('#btnSort').hidden = home || !!opt.noSearch;
  $('#btnLayout').hidden = home || !!opt.noSearch;
  $('#btnHome').hidden = home;
}

function setTitle(main, sub) {
  $('#topTitle').textContent = main || '局域网文件';
  $('#topSub').textContent = sub || '';
}

function renderCrumbs(path) {
  const bar = $('#crumbs');
  if (!path) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  const parts = path.split('\\').filter(Boolean);
  let acc = '';
  const frag = document.createDocumentFragment();
  parts.forEach((part, i) => {
    acc = i === 0 ? part + '\\' : acc.replace(/\\$/, '') + '\\' + part;
    const btn = document.createElement('button');
    btn.className = 'crumb' + (i === parts.length - 1 ? ' last' : '');
    btn.textContent = i === 0 ? part.replace(':', '') + ' 盘' : part;
    btn.addEventListener('click', () => {
      if (acc !== S.dir) openDir(acc, { push: true });
    });
    frag.appendChild(btn);
    if (i < parts.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      frag.appendChild(sep);
    }
  });
  bar.innerHTML = '';
  bar.appendChild(frag);
  bar.scrollLeft = bar.scrollWidth;
}

/* ------------------------------ 目录 ------------------------------ */
async function getDir(path, force) {
  const key = path + '|' + S.sort + '|' + S.order;
  const hit = S.cache.get(key);
  if (!force && hit && Date.now() - hit.ts < 12000) return hit.data;
  const data = await dirApi(path, S.sort, S.order);
  S.cache.set(key, { data, ts: Date.now() });
  if (S.cache.size > 40) {
    const first = S.cache.keys().next().value;
    S.cache.delete(first);
  }
  return data;
}

async function openDir(path, opts = {}) {
  if (!path) return false;
  closeOverlays();
  exitSearch(false);
  setLoading(true);
  try {
    const data = await getDir(path, opts.force);
    S.dir = data.path;
    S.dirData = data;
    S.items = (data.entries || []).map((e) => ({
      name: e.name,
      type: e.type,
      size: e.size,
      mtime: e.mtime,
      ext: e.ext,
      path: joinPath(data.path, e.name),
    }));
    S.images = S.items.filter((x) => x.type === 'image');
    renderDirView();
    showView('fileView');
    updateTopbar({});
    if (opts.history !== 'none') {
      const push = opts.push !== false;
      const url = dirUrl(data.path);
      if (push) history.pushState({}, '', url);
      else history.replaceState({}, '', url);
    }
    scrollTop();
    return true;
  } catch (err) {
    toast('打开失败：' + err.message);
    return false;
  } finally {
    setLoading(false);
  }
}

function countTypes(items) {
  let dirs = 0, images = 0, videos = 0, texts = 0;
  for (const it of items) {
    if (it.type === 'dir') dirs++;
    else if (it.type === 'image') images++;
    else if (it.type === 'video') videos++;
    else if (it.type === 'text') texts++;
  }
  return { dirs, images, videos, texts };
}

function renderDirView() {
  const data = S.dirData;
  const c = countTypes(S.items);
  setTitle(data.name, data.path);
  renderCrumbs(data.path);
  updateTopbar({});

  const parts = [];
  if (c.dirs) parts.push(c.dirs + ' 个文件夹');
  if (c.images) parts.push(c.images + ' 张图片');
  if (c.videos) parts.push(c.videos + ' 个视频');
  const rest = S.items.length - c.dirs - c.images - c.videos;
  if (rest > 0) parts.push(rest + ' 个文件');

  $('#toolbar').innerHTML =
    '<span class="count">' + (parts.join(' · ') || '空文件夹') + '</span>' +
    (data.truncated ? '<span class="hint">仅显示前 ' + S.items.length + ' 项</span>' : '');

  // 视图按钮图标
  $('#btnLayout use').setAttribute('href', S.view === 'grid' ? '#i-list' : '#i-grid');

  const container = $('#fileList');
  container.className = 'file-list ' + (S.view === 'grid' ? 'grid' : 'list');
  container.innerHTML = '';

  if (!S.items.length) {
    container.innerHTML =
      '<div class="empty" style="grid-column:1/-1"><svg class="ic"><use href="#i-folder"/></svg>' +
      '<div>这个文件夹是空的</div></div>';
    $('#fileMore').hidden = true;
    return;
  }

  renderList = S.items;
  renderedCount = 0;
  appendChunk();
}

function tileHTML(it, idx) {
  const isDir = it.type === 'dir';
  const icon = ICON[it.type] || 'i-file';
  let media = '';
  let ext = '';
  if (it.type === 'image') {
    media =
      '<img data-thumb="' + b64e(it.path) + '" data-v="' + (it.mtime || 0) + '" alt="">' +
      '<div class="ph"><svg class="ic"><use href="#i-image"/></svg></div>';
  } else {
    media = '<svg class="ic big-ic"><use href="#' + icon + '"/></svg>';
    if (!isDir && it.ext) ext = '<span class="tile-ext">' + esc(it.ext.toUpperCase()) + '</span>';
  }
  const badge = it.type === 'video'
    ? '<span class="tile-badge"><svg class="ic"><use href="#i-play"/></svg></span>'
    : '';
  const delay = Math.min(idx, 20) * 12;
  return (
    '<button class="tile ' + it.type + '" data-idx="' + idx + '" style="animation-delay:' + delay + 'ms">' +
    '<div class="tile-thumb">' + media + ext + badge + '</div>' +
    '<div class="tile-name">' + esc(it.name) + '</div>' +
    '</button>'
  );
}

function rowHTML(it, idx) {
  const isDir = it.type === 'dir';
  const icon = ICON[it.type] || 'i-file';
  let media = '<svg class="ic"><use href="#' + icon + '"/></svg>';
  if (it.type === 'image') {
    media =
      '<img data-thumb="' + b64e(it.path) + '" data-v="' + (it.mtime || 0) + '" alt="">' +
      '<svg class="ic"><use href="#i-image"/></svg>';
  }
  const sub = isDir ? '文件夹' : (fmtSize(it.size) + ' · ' + fmtTime(it.mtime));
  return (
    '<button class="row" data-idx="' + idx + '">' +
    '<div class="row-ic ' + it.type + '">' + media + '</div>' +
    '<div class="row-main">' +
    '<div class="row-name">' + esc(it.name) + '</div>' +
    '<div class="row-sub">' + esc(sub) + '</div>' +
    '</div>' +
    '<svg class="ic" style="width:16px;height:16px;color:var(--text-3)"><use href="#i-chevron"/></svg>' +
    '</button>'
  );
}

/* 图片懒加载 */
const thumbObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    const img = en.target;
    thumbObserver.unobserve(img);
    loadThumb(img);
  }
}, { rootMargin: '400px 0px' });

function loadThumb(img) {
  if (img.dataset.src) return;
  const p = img.dataset.thumb;
  const mtime = img.dataset.v || 0;
  const size = img.closest('.row-ic') ? 96 : 400;
  const src = 'thumb?p=' + p + '&s=' + size + (mtime ? '&v=' + mtime : '');
  img.dataset.src = src;
  img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = src;
}

function observeThumbs(root) {
  root.querySelectorAll('img[data-thumb]').forEach((img) => {
    if (!img.dataset.observed) {
      img.dataset.observed = '1';
      thumbObserver.observe(img);
    }
  });
}

function appendChunk() {
  const container = $('#fileList');
  const frag = document.createDocumentFragment();
  const end = Math.min(renderedCount + PAGE, renderList.length);
  for (let i = renderedCount; i < end; i++) {
    const it = renderList[i];
    const tmp = document.createElement('div');
    tmp.innerHTML = S.view === 'grid' ? tileHTML(it, i) : rowHTML(it, i);
    frag.appendChild(tmp.firstElementChild);
  }
  container.appendChild(frag);
  observeThumbs(container);
  renderedCount = end;
  $('#fileMore').hidden = renderedCount >= renderList.length;
}

/* ------------------------------ 打开文件 ------------------------------ */
function openItem(item, opts = {}) {
  const push = opts.push !== false;
  if (item.type === 'dir') {
    openDir(item.path, { push: true });
    return;
  }
  if (item.type === 'image') {
    const sameDir = dirname(item.path).toLowerCase() === (S.dir || '').toLowerCase();
    const list = opts.list || (sameDir && S.images.length ? S.images : [item]);
    openViewer(item, list, push);
    return;
  }
  if (item.type === 'text') {
    openReader(item, push);
    return;
  }
  if (item.type === 'video' || item.type === 'audio') {
    openPlayer(item, push);
    return;
  }
  if (item.type === 'pdf') {
    download(item);
    return;
  }
  // 其它类型：先尝试当文本打开（README、无扩展名文件等）
  probeText(item, push);
}

async function probeText(item, push) {
  try {
    const data = await textApi(item.path);
    openReader(item, push, data);
  } catch (err) {
    if (err.status === 415) download(item);
    else download(item);
  }
}

function openFileByPath(path, opts = {}) {
  const found = S.items.find((x) => x.path === path);
  if (found) { openItem(found, opts); return; }
  const name = path.split('\\').pop() || path;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'svg', 'jfif'];
  const videoExts = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp', 'ts'];
  const audioExts = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac', 'opus'];
  const textExts = ['txt', 'md', 'log', 'json', 'csv', 'ini', 'yml', 'yaml', 'xml',
    'html', 'css', 'js', 'py', 'bat', 'ps1', 'sh', 'srt', 'lrc', 'config'];
  let type = 'file';
  if (imageExts.includes(ext)) type = 'image';
  else if (videoExts.includes(ext)) type = 'video';
  else if (audioExts.includes(ext)) type = 'audio';
  else if (textExts.includes(ext)) type = 'text';
  openItem({ name, path, type, size: 0, mtime: 0, ext }, opts);
}

/* ------------------------------ 覆盖层 ------------------------------ */
function showOverlayEl(name) {
  const el = document.getElementById(name);
  if (el) el.hidden = false;
  S.overlay = name;
}

function hideOverlayEl() {
  ['viewer', 'reader', 'player'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  S.overlay = null;
}

function hideViewer() {
  const img = $('#vImg');
  img.classList.remove('ready');
  img.removeAttribute('src');
  img.style.transform = '';
  img.style.opacity = '';
  $('#vSpinner').classList.remove('on');
  V.list = [];
  V.index = 0;
}

function stopPlayer() {
  const body = $('#pBody');
  const media = body.querySelector('video, audio');
  if (media) {
    try { media.pause(); } catch (e) { /* ignore */ }
    media.removeAttribute('src');
    try { media.load(); } catch (e) { /* ignore */ }
  }
  body.innerHTML = '';
}

function closeOverlays() {
  hideViewer();
  stopPlayer();
  hideOverlayEl();
  closeSheet();
}

/* ------------------------------ 看图器 ------------------------------ */
const V = { list: [], index: 0, raw: false };

function openViewer(item, list, push) {
  closeOverlays();
  V.list = list && list.length ? list : [item];
  V.index = Math.max(0, V.list.findIndex((x) => x.path === item.path));
  if (V.index < 0) { V.list = [item]; V.index = 0; }
  V.raw = false;
  showOverlayEl('viewer');
  showImage(false, false);
  if (push) history.pushState({ open: true, path: item.path }, '', openUrl(S.dir, item.path));
}

function showImage(updateUrl, sliding) {
  const it = V.list[V.index];
  if (!it) return;
  const img = $('#vImg');
  const spinner = $('#vSpinner');
  $('#vName').textContent = it.name;
  $('#vCount').textContent = V.list.length > 1 ? (V.index + 1) + ' / ' + V.list.length : '';
  $('#vOriginal').classList.toggle('on', V.raw);

  img.classList.remove('ready');
  spinner.classList.add('on');
  img.style.transition = 'none';
  img.style.transform = 'translate3d(0,0,0) scale(1)';
  img.style.opacity = '';
  resetTransform(false);

  const src = V.raw ? rawUrl(it.path, it.mtime) : viewUrl(it.path, it.mtime, 1800);
  img.onload = () => {
    img.classList.add('ready');
    spinner.classList.remove('on');
    applyTransform(0);
  };
  img.onerror = () => {
    spinner.classList.remove('on');
    toast('这张图片无法预览，可点「保存」或「原图」查看');
    img.classList.remove('ready');
  };
  img.src = src;

  // 预加载左右
  preload(V.index + 1);
  preload(V.index - 1);

  if (updateUrl && history.state && history.state.open) {
    history.replaceState({ open: true, path: it.path }, '', openUrl(S.dir, it.path));
  }
}

function preload(idx) {
  const it = V.list[idx];
  if (!it) return;
  const img = new Image();
  img.src = viewUrl(it.path, it.mtime, 1800);
}

function gotoImage(delta) {
  const next = V.index + delta;
  if (next < 0 || next >= V.list.length) {
    toast(delta > 0 ? '已经是最后一张' : '已经是第一张', 1200);
    return;
  }
  V.index = next;
  V.raw = false;
  showImage(true, true);
}

function closeViewer() {
  if (S.overlay !== 'viewer') return;
  hideViewer();
  hideOverlayEl();
  if (history.state && history.state.open) history.back();
  else if (S.dir) history.replaceState({}, '', dirUrl(S.dir));
}

/* --- 看图器手势 --- */
let ptrs = new Map();
let gesture = null;
let tr = { s: 1, x: 0, y: 0 };
let lastTap = 0, lastTapX = 0, lastTapY = 0;

function applyTransform(dur) {
  const img = $('#vImg');
  img.style.transition = dur ? 'transform ' + dur + 'ms cubic-bezier(.2,.8,.2,1)' : 'none';
  img.style.transform = 'translate3d(' + tr.x + 'px,' + tr.y + 'px,0) scale(' + tr.s + ')';
}

function resetTransform(animate) {
  tr = { s: 1, x: 0, y: 0 };
  applyTransform(animate ? 220 : 0);
}

function clampPan() {
  const img = $('#vImg');
  const stage = $('#vStage');
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  const iw = img.clientWidth || w;
  const ih = img.clientHeight || h;
  const maxX = Math.max(0, (iw * tr.s - w) / 2 + 16);
  const maxY = Math.max(0, (ih * tr.s - h) / 2 + 16);
  tr.x = clamp(tr.x, -maxX, maxX);
  tr.y = clamp(tr.y, -maxY, maxY);
}

function toggleZoom(cx, cy) {
  if (tr.s > 1.5) { resetTransform(true); return; }
  const stage = $('#vStage');
  const rect = stage.getBoundingClientRect();
  const ox = cx - rect.left - rect.width / 2;
  const oy = cy - rect.top - rect.height / 2;
  tr.s = 2.6;
  tr.x = ox * (1 - tr.s);
  tr.y = oy * (1 - tr.s);
  clampPan();
  applyTransform(240);
}

function onPointerDown(e) {
  if (S.overlay !== 'viewer') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 1) {
    gesture = {
      type: 'pan', x0: e.clientX, y0: e.clientY,
      bx: tr.x, by: tr.y, dx: 0, dy: 0, moved: false,
    };
    const img = $('#vImg');
    img.style.transition = 'none';
  } else if (ptrs.size === 2) {
    const arr = Array.from(ptrs.values());
    const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    gesture = { type: 'pinch', d0: Math.max(d, 1), s0: tr.s, x0: tr.x, y0: tr.y };
  }
}

function onPointerMove(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  const img = $('#vImg');
  if (gesture.type === 'pan' && ptrs.size === 1) {
    const dx = e.clientX - gesture.x0;
    const dy = e.clientY - gesture.y0;
    gesture.dx = dx;
    gesture.dy = dy;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) gesture.moved = true;
    if (tr.s > 1.02) {
      tr.x = gesture.bx + dx;
      tr.y = gesture.by + dy;
      clampPan();
      applyTransform(0);
    } else if (Math.abs(dx) > Math.abs(dy)) {
      img.style.transition = 'none';
      img.style.transform = 'translate3d(' + dx + 'px,0,0) scale(1)';
      img.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / 520));
    }
  } else if (gesture.type === 'pinch' && ptrs.size >= 2) {
    const arr = Array.from(ptrs.values());
    const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
    tr.s = clamp(gesture.s0 * (d / gesture.d0), 1, 6);
    tr.x = gesture.x0;
    tr.y = gesture.y0;
    clampPan();
    applyTransform(0);
  }
}

function onPointerUp(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  const img = $('#vImg');
  if (ptrs.size === 0 && gesture) {
    const g = gesture;
    gesture = null;
    const tap = !g.moved && g.type === 'pan';
    if (g.type === 'pan' && tr.s <= 1.02) {
      if (g.moved && Math.abs(g.dx) > 70 && Math.abs(g.dx) > Math.abs(g.dy)) {
        gotoImage(g.dx < 0 ? 1 : -1);
      }
      resetTransform(true);
      img.style.opacity = '1';
    } else if (tr.s <= 1.02) {
      resetTransform(true);
    } else {
      clampPan();
      applyTransform(180);
    }
    if (tap) {
      const now = Date.now();
      if (now - lastTap < 300 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 44) {
        toggleZoom(e.clientX, e.clientY);
        lastTap = 0;
      } else {
        lastTap = now;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
    }
  } else if (ptrs.size === 1) {
    const p = Array.from(ptrs.values())[0];
    gesture = {
      type: 'pan', x0: p.x, y0: p.y, bx: tr.x, by: tr.y,
      dx: 0, dy: 0, moved: true,
    };
  }
}

/* ------------------------------ 阅读器 ------------------------------ */
let readerFontSize = parseInt(localStorage.getItem('lfb.readerFs') || '15', 10) || 15;

function setReaderFont(delta) {
  readerFontSize = clamp(readerFontSize + delta, 11, 26);
  document.documentElement.style.setProperty('--reader-fs', readerFontSize + 'px');
  localStorage.setItem('lfb.readerFs', String(readerFontSize));
}

async function openReader(item, push, preloaded) {
  closeOverlays();
  showOverlayEl('reader');
  $('#rName').textContent = item.name;
  $('#rMeta').textContent = '';
  const textEl = $('#rText');
  const body = $('#rBody');
  document.documentElement.style.setProperty('--reader-fs', readerFontSize + 'px');
  body.scrollTop = 0;

  if (push) history.pushState({ open: true, path: item.path }, '', openUrl(S.dir, item.path));

  if (preloaded) {
    renderReader(preloaded);
    return;
  }
  textEl.textContent = '正在读取…';
  try {
    const data = await textApi(item.path);
    renderReader(data);
  } catch (err) {
    if (err.status === 415) {
      hideOverlayEl();
      download(item);
    } else {
      textEl.textContent = '无法打开这个文件：' + err.message;
    }
  }
}

function renderReader(data) {
  const textEl = $('#rText');
  textEl.textContent = data.content || '';
  let meta = (data.encoding || '文本') + ' · ' + fmtSize(data.size);
  if (data.truncated) meta += ' · 文件过大，仅显示前半部分';
  $('#rMeta').textContent = meta;
  $('#rBody').scrollTop = 0;
}

function closeReader() {
  if (S.overlay !== 'reader') return;
  $('#rText').textContent = '';
  hideOverlayEl();
  if (history.state && history.state.open) history.back();
  else if (S.dir) history.replaceState({}, '', dirUrl(S.dir));
}

/* ------------------------------ 播放器 ------------------------------ */
let currentMedia = null;

function openPlayer(item, push) {
  closeOverlays();
  currentMedia = item;
  showOverlayEl('player');
  $('#pName').textContent = item.name;
  $('#pMeta').textContent = (item.type === 'video' ? '视频' : '音频') +
    (item.size ? ' · ' + fmtSize(item.size) : '');
  const body = $('#pBody');
  const src = rawUrl(item.path, item.mtime);
  if (item.type === 'video') {
    body.innerHTML =
      '<video src="' + esc(src) + '" controls playsinline autoplay ' +
      'preload="metadata" style="width:100%;max-height:100%"></video>';
  } else {
    body.innerHTML =
      '<div class="p-audio-card"><div class="disc"></div>' +
      '<audio src="' + esc(src) + '" controls autoplay preload="metadata"></audio></div>';
  }
  if (push) history.pushState({ open: true, path: item.path }, '', openUrl(S.dir, item.path));
  const media = body.querySelector('video, audio');
  if (media) {
    media.addEventListener('error', () => {
      toast('这个格式浏览器可能不支持播放，可以点右上角下载');
    }, { once: true });
  }
}

function closePlayer() {
  if (S.overlay !== 'player') return;
  stopPlayer();
  currentMedia = null;
  hideOverlayEl();
  if (history.state && history.state.open) history.back();
  else if (S.dir) history.replaceState({}, '', dirUrl(S.dir));
}

/* ------------------------------ 底部面板 ------------------------------ */
function showSheet(html) {
  const sheet = $('#sheet');
  $('#sheetBody').innerHTML = html;
  sheet.hidden = false;
  sheet.classList.remove('closing');
}

function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet || sheet.hidden) return;
  sheet.classList.add('closing');
  setTimeout(() => {
    sheet.hidden = true;
    sheet.classList.remove('closing');
    $('#sheetBody').innerHTML = '';
  }, 150);
}

function openSortSheet() {
  const sorts = [
    { key: 'name', label: '名称' },
    { key: 'time', label: '修改时间' },
    { key: 'size', label: '文件大小' },
  ];
  let html = '<div class="sheet-title">排序方式</div>';
  for (const s of sorts) {
    const active = S.sort === s.key;
    html +=
      '<button class="sheet-item ' + (active ? 'active' : '') + '" data-sort="' + s.key + '">' +
      '<svg class="ic"><use href="#' + (active ? 'i-check' : 'i-sort') + '"/></svg>' +
      '<span class="grow">' + s.label + '</span></button>';
  }
  html += '<div class="sheet-title" style="margin-top:12px">方向</div>';
  html +=
    '<button class="sheet-item ' + (S.order === 'asc' ? 'active' : '') + '" data-order="asc">' +
    '<svg class="ic"><use href="#' + (S.order === 'asc' ? 'i-check' : 'i-sort') + '"/></svg>' +
    '<span class="grow">升序</span><span class="val">A → Z · 旧 → 新</span></button>' +
    '<button class="sheet-item ' + (S.order === 'desc' ? 'active' : '') + '" data-order="desc">' +
    '<svg class="ic"><use href="#' + (S.order === 'desc' ? 'i-check' : 'i-sort') + '"/></svg>' +
    '<span class="grow">降序</span><span class="val">Z → A · 新 → 旧</span></button>';
  showSheet(html);

  $$('#sheetBody [data-sort]').forEach((el) => el.addEventListener('click', () => {
    S.sort = el.dataset.sort;
    localStorage.setItem('lfb.sort', S.sort);
    closeSheet();
    reloadDir();
  }));
  $$('#sheetBody [data-order]').forEach((el) => el.addEventListener('click', () => {
    S.order = el.dataset.order;
    localStorage.setItem('lfb.order', S.order);
    closeSheet();
    reloadDir();
  }));
}

function reloadDir() {
  if (!S.dir) return;
  S.cache.clear();
  openDir(S.dir, { history: 'none' });
}

function openInfoSheet(item) {
  const rows = [];
  rows.push(['名称', item.name]);
  rows.push(['类型', typeLabel(item.type)]);
  if (item.size) rows.push(['大小', fmtSize(item.size) + '（' + item.size.toLocaleString() + ' 字节）']);
  if (item.mtime) rows.push(['修改时间', new Date(item.mtime * 1000).toLocaleString('zh-CN')]);
  rows.push(['_loading', '正在读取详细信息…']);
  showSheet('<div class="sheet-handle"></div><div class="sheet-title">文件信息</div>' +
    '<dl class="info-grid">' +
    rows.map(([k, v]) => (k === '_loading'
      ? '<dt></dt><dd style="color:var(--text-3)" id="infoLoading">' + esc(v) + '</dd>'
      : '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>')).join('') +
    '</dl>');

  infoApi(item.path).then((info) => {
    const extra = [];
    if (info.width && info.height) extra.push(['尺寸', info.width + ' × ' + info.height + ' 像素']);
    if (info.taken) extra.push(['拍摄时间', info.taken]);
    if (info.camera) extra.push(['相机', info.camera]);
    extra.push(['完整路径', info.path]);
    const dl = $('#sheetBody .info-grid');
    if (!dl) return;
    dl.innerHTML = rows.filter(([k]) => k !== '_loading')
      .map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>')
      .concat(extra.map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'))
      .join('');
  }).catch(() => {
    const el = $('#infoLoading');
    if (el) el.textContent = '读取详细信息失败';
  });
}

function typeLabel(type) {
  return {
    dir: '文件夹', image: '图片', video: '视频', audio: '音频',
    text: '文本', pdf: 'PDF 文档', file: '文件',
  }[type] || '文件';
}

/* ------------------------------ 搜索 ------------------------------ */
let searchTimer = null;

function openSearch() {
  if (!S.dirData) return;
  S.searchMode = true;
  $('#searchbar').hidden = false;
  $('#searchInput').value = '';
  $('#searchInput').focus();
  showView('resultView');
  $('#resultView').innerHTML = '<div class="empty">输入关键词开始搜索<br>' +
    '<span style="opacity:.6;font-size:12px">在当前文件夹及子文件夹中查找</span></div>';
  $('#topTitle').textContent = '搜索';
  $('#topSub').textContent = S.dirData.path;
}

function exitSearch(restore) {
  if (!S.searchMode) return;
  S.searchMode = false;
  clearTimeout(searchTimer);
  $('#searchbar').hidden = true;
  $('#searchInput').value = '';
  if (restore !== false && S.dirData) {
    showView('fileView');
    setTitle(S.dirData.name, S.dirData.path);
  }
}

function closeSearch() {
  exitSearch(true);
}

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('#searchInput').value.trim();
  if (!q) {
    $('#resultView').innerHTML = '<div class="empty">输入关键词开始搜索</div>';
    return;
  }
  searchTimer = setTimeout(() => doSearch(q), 320);
}

async function doSearch(q) {
  const view = $('#resultView');
  view.innerHTML = '<div class="empty">正在搜索…</div>';
  try {
    const data = await searchApi(S.dir, q);
    renderSearchResults(data, q);
  } catch (err) {
    view.innerHTML = '<div class="empty">搜索失败：' + esc(err.message) + '</div>';
  }
}

function renderSearchResults(data, q) {
  const results = data.results || [];
  const view = $('#resultView');
  if (!results.length) {
    view.innerHTML = '<div class="empty"><svg class="ic"><use href="#i-search"/></svg>' +
      '<div>没有找到与「' + esc(q) + '」匹配的文件</div></div>';
    return;
  }
  view.innerHTML = '<div class="search-head">找到 ' + results.length + ' 个结果' +
    (results.length >= 300 ? '（仅显示前 300 个）' : '') + '</div><div class="file-list list" id="resultList"></div>';
  const container = $('#resultList');
  const frag = document.createDocumentFragment();
  results.forEach((it) => {
    const item = {
      name: it.name, type: it.type, size: it.size, mtime: it.mtime,
      ext: it.ext, path: it.path, rel: it.rel,
    };
    const row = document.createElement('button');
    row.className = 'row';
    const icon = ICON[item.type] || 'i-file';
    row.innerHTML =
      '<div class="row-ic ' + item.type + '">' +
      (item.type === 'image'
        ? '<img data-thumb="' + b64e(item.path) + '" data-v="' + item.mtime + '" alt="">' +
          '<svg class="ic"><use href="#i-image"/></svg>'
        : '<svg class="ic"><use href="#' + icon + '"/></svg>') +
      '</div>' +
      '<div class="row-main">' +
      '<div class="row-name">' + esc(item.name) + '</div>' +
      '<div class="row-sub">' + esc(it.rel || '') + '</div>' +
      '</div>' +
      '<svg class="ic" style="width:16px;height:16px;color:var(--text-3)"><use href="#i-chevron"/></svg>';
    row.addEventListener('click', () => {
      if (item.type === 'dir') {
        exitSearch(false);
        openDir(item.path, { push: true });
      } else {
        const list = item.type === 'image' && dirname(item.path).toLowerCase() === (S.dir || '').toLowerCase()
          ? S.images : [item];
        openItem(item, { push: true, list });
      }
    });
    frag.appendChild(row);
  });
  container.appendChild(frag);
  observeThumbs(container);
}

/* ------------------------------ 事件绑定 ------------------------------ */
function bindEvents() {
  $('#btnHome').addEventListener('click', () => {
    if (S.overlay) return;
    showLocations(true);
  });

  $('#btnBack').addEventListener('click', () => {
    if (S.searchMode) { exitSearch(true); return; }
    if (!S.dirData) { showLocations(true); return; }
    if (S.dirData.parent) openDir(S.dirData.parent, { push: true });
    else showLocations(true);
  });

  $('#btnLayout').addEventListener('click', () => {
    S.view = S.view === 'grid' ? 'list' : 'grid';
    localStorage.setItem('lfb.view', S.view);
    $('#btnLayout use').setAttribute('href', S.view === 'grid' ? '#i-list' : '#i-grid');
    renderDirView();
  });

  $('#btnSort').addEventListener('click', () => {
    if (!S.dir) return;
    openSortSheet();
  });

  $('#btnSearch').addEventListener('click', () => {
    if (S.searchMode) { exitSearch(true); return; }
    openSearch();
  });

  $('#btnSearchCancel').addEventListener('click', () => { exitSearch(true); });
  $('#searchInput').addEventListener('input', onSearchInput);

  $('#fileList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-idx]');
    if (!el) return;
    const it = S.items[Number(el.dataset.idx)];
    if (!it) return;
    openItem(it, { push: true });
  });

  $('#btnMore').addEventListener('click', appendChunk);

  // 看图器
  $('#vClose').addEventListener('click', closeViewer);
  $('#vPrev').addEventListener('click', () => gotoImage(-1));
  $('#vNext').addEventListener('click', () => gotoImage(1));
  $('#vDownload').addEventListener('click', () => {
    const it = V.list[V.index];
    if (it) download(it);
  });
  $('#vOriginal').addEventListener('click', () => {
    const it = V.list[V.index];
    if (!it) return;
    V.raw = !V.raw;
    showImage(true, false);
    toast(V.raw ? '已切换原图' : '已切换预览图', 1200);
  });
  $('#vInfo').addEventListener('click', () => {
    const it = V.list[V.index];
    if (it) openInfoSheet(it);
  });

  const stage = $('#vStage');
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // 阅读器
  $('#rClose').addEventListener('click', closeReader);
  $('#rMinus').addEventListener('click', () => setReaderFont(-1));
  $('#rPlus').addEventListener('click', () => setReaderFont(1));

  // 播放器
  $('#pClose').addEventListener('click', closePlayer);
  $('#pDownload').addEventListener('click', () => {
    if (currentMedia) download(currentMedia);
  });

  // 面板背景点击关闭
  $('#sheet').addEventListener('click', (e) => {
    if (e.target === $('#sheet')) closeSheet();
  });

  // 浏览器返回
  window.addEventListener('popstate', () => { applyUrl(); });

  // 键盘（桌面）
  window.addEventListener('keydown', (e) => {
    if (S.overlay === 'viewer') {
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') gotoImage(-1);
      else if (e.key === 'ArrowRight') gotoImage(1);
    } else if (S.overlay === 'reader' || S.overlay === 'player') {
      if (e.key === 'Escape') {
        if (S.overlay === 'reader') closeReader(); else closePlayer();
      }
    }
  });

  // 滚动加载更多
  const main = $('#main');
  main.addEventListener('scroll', () => {
    if (S.overlay) return;
    if (renderedCount < renderList.length && main.scrollTop + main.clientHeight > main.scrollHeight - 600) {
      appendChunk();
    }
  }, { passive: true });
}

/* ------------------------------ 启动 ------------------------------ */
async function boot() {
  applyTheme();
  bindEvents();
  try {
    const st = parseUrl();
    if (st.dir) {
      const ok = await openDir(st.dir, { history: 'none' });
      if (ok && st.open) {
        const item = S.items.find((x) => x.path === st.open);
        if (item) openItem(item, { push: false });
        else openFileByPath(st.open, { push: false });
      }
      if (!ok) await showLocations(false);
    } else {
      await showLocations(false);
    }
  } catch (err) {
    toast('启动失败：' + err.message);
    showLocations(false);
  }
}

document.addEventListener('DOMContentLoaded', boot);
