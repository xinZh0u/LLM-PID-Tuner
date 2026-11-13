import { Emitter } from './core/emitter.js';
import { Hub } from './core/hub.js';
import { Conn } from './core/conn.js';
import { Page } from './ui/page.js';
import { initAgent } from './ui/agent.js';
import { initProject } from './ui/projectPanel.js';
import { initTheme, onThemeChange, cycleMode, getMode, getModeLabel } from './ui/theme.js';

const LS_KEY = 'llmtuner.ui.v2';

const hub = new Hub();
const conn = new Conn(hub);

const app = {
  hub,
  conn,
  pages: [],
  activeId: null,
  bus: new Emitter(),

  emit(ev, ...a) {
    this.bus.emit(ev, ...a);
  },
  on(ev, fn) {
    return this.bus.on(ev, fn);
  },
  activePage() {
    return this.pages.find((p) => p.id === this.activeId) || null;
  },
  persist() {
    schedulePersist();
  },
  scheduleTransSync,
  renderTabs,
};

/* ------------------------------------------------------------------ */
/* 分页                                                                */
/* ------------------------------------------------------------------ */

const $tabs = document.getElementById('tabs');
const $pages = document.getElementById('pages');

function newId() {
  return 'p' + Math.random().toString(36).slice(2, 8);
}

function createPage(state) {
  const page = new Page(app, state || { id: newId(), title: 'new tab', format: 'tuner' });
  page.mount($pages);
  app.pages.push(page);
  return page;
}

function activate(id) {
  app.activeId = id;
  for (const p of app.pages) p.setActive(p.id === id);
  renderTabs();
  schedulePersist();
}

function closePage(id) {
  const i = app.pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [page] = app.pages.splice(i, 1);
  page.unmount();
  if (app.activeId === id) {
    const next = app.pages[Math.min(i, app.pages.length - 1)];
    if (next) activate(next.id);
    else app.activeId = null;
  }
  if (!app.pages.length) {
    const p = createPage();
    activate(p.id);
  }
  renderTabs();
  schedulePersist();
  scheduleTransSync();
}

function renderTabs() {
  $tabs.innerHTML = '';
  for (const p of app.pages) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (p.id === app.activeId ? ' active' : '');
    tab.dataset.id = p.id;
    tab.title = p.title;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.title;
    const fmt = document.createElement('span');
    fmt.className = 'fmt';
    fmt.textContent = p.format === 'raw' ? 'RAW' : 'Tuner';
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = '关闭分页';
    tab.append(name, fmt, x);
    tab.addEventListener('click', (e) => {
      if (e.target === x) return;
      activate(p.id);
    });
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) closePage(p.id);
    });
    tab.addEventListener('dblclick', () => {
      const t = window.prompt('分页名称', p.title);
      if (t !== null) {
        p.setTitle(t.trim() || 'new tab');
        schedulePersist();
      }
    });
    x.addEventListener('click', () => closePage(p.id));
    $tabs.appendChild(tab);
  }
}

document.getElementById('addTab').addEventListener('click', () => {
  const p = createPage();
  activate(p.id);
});

/* ------------------------------------------------------------------ */
/* 传输位图同步：所有 Tuner 分页绘制中的参数取并集                         */
/* ------------------------------------------------------------------ */

let transTimer = 0;
function scheduleTransSync() {
  clearTimeout(transTimer);
  transTimer = setTimeout(syncTransmit, 150);
}

function syncTransmit() {
  const tunerPages = app.pages.filter((p) => p.format === 'tuner');
  if (!conn.connected || !hub.params.length || !tunerPages.length) return;
  const flags = new Array(hub.params.length).fill(false);
  for (const p of tunerPages) {
    for (const i of p.visibleIndices()) {
      if (i < flags.length) flags[i] = true;
    }
  }
  hub.sendTransSet(flags);
}

hub.on('params', () => {
  scheduleTransSync();
  schedulePersist();
});
conn.on('state', () => {
  updateBadge();
  if (conn.connected) scheduleTransSync();
});
conn.on('ports', updateBadge);

function updateBadge() {
  const el = document.getElementById('connBadge');
  const s = conn.status;
  const label = { idle: '未连接', connecting: '连接中…', open: '已连接', error: '连接错误' }[s] || s;
  el.textContent =
    s === 'open'
      ? `已连接 · ${conn.portKey === 'mock' ? '模拟' : '串口'} · ${conn.opts.baudRate}`
      : label;
  el.classList.toggle('on', s === 'open');
  el.title = conn.error || '';
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

const themeBtn = document.getElementById('themeBtn');

function syncThemeBtn() {
  const mode = getMode();
  themeBtn.textContent = mode === 'auto' ? '◐' : mode === 'light' ? '☀' : '☾';
  themeBtn.title = '主题：' + getModeLabel() + '（点击切换）';
  themeBtn.classList.toggle('active', mode !== 'auto');
}

themeBtn.addEventListener('click', () => {
  cycleMode();
  syncThemeBtn();
});

initTheme();
onThemeChange(() => {
  for (const p of app.pages) p.onThemeChange();
});
syncThemeBtn();

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

let persistTimer = 0;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(doPersist, 400);
}

function doPersist() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        activeId: app.activeId,
        portKey: conn.portKey,
        opts: conn.opts,
        pages: app.pages.map((p) => p.toState()),
      })
    );
  } catch (_) {}
}

function restore() {
  let state = null;
  try {
    state = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  } catch (_) {}
  if (!state || !Array.isArray(state.pages) || !state.pages.length) {
    const p = createPage();
    activate(p.id);
    return;
  }
  if (state.portKey) conn.portKey = state.portKey;
  if (state.opts) conn.setOpts(state.opts);
  for (const ps of state.pages) createPage(ps);
  const active = app.pages.find((p) => p.id === state.activeId) || app.pages[0];
  activate(active.id);
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */

function frame(ts) {
  tick(ts);
  requestAnimationFrame(frame);
}

function tick(ts) {
  hub.tickStats();
  for (const p of app.pages) p.tick(ts);
}

// 后台标签页里 rAF 会被暂停，用定时器兜底刷新统计
setInterval(() => {
  if (document.hidden) tick(performance.now());
}, 250);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

if (!conn.supported) {
  const toast = document.getElementById('noserial');
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 12000);
}

restore();
updateBadge();
initAgent(app);
initProject(app);
requestAnimationFrame(frame);

// 便于调试
window.__app = app;

window.addEventListener('beforeunload', () => {
  doPersist();
  conn.disconnect();
});

console.log('[LLM_Tuner] ready');
