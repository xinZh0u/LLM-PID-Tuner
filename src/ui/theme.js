import { setPaletteTheme } from './chart.js';

/**
 * 主题：auto（跟随 VS Code / 系统）| light | dark
 * - 在扩展托管页面里会轮询 /api/theme，跟随 VS Code 当前配色方案实时切换
 * - 在普通浏览器里跟随 prefers-color-scheme
 */
const KEY = 'llmtuner.theme';
const ORDER = ['auto', 'light', 'dark'];
const LABEL = { auto: '跟随 VS Code', light: '浅色', dark: '深色' };

let mode = 'auto';
let effective = 'dark';
let lastApplied = '';
let vsTheme = null;
let injected = null;
let pollTimer = 0;
let mql = null;
const listeners = new Set();

function desired() {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  if (vsTheme) return vsTheme;
  if (mql) return mql.matches ? 'dark' : 'light';
  return 'dark';
}

function apply() {
  const next = desired();
  const changed = next !== lastApplied;
  lastApplied = next;
  effective = next;
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  setPaletteTheme(next);
  if (changed) for (const fn of listeners) fn(next);
}

async function poll() {
  if (!injected) return;
  try {
    const res = await fetch(injected.base.replace(/\/+$/, '') + '/theme', {
      headers: injected.token ? { Authorization: 'Bearer ' + injected.token } : {},
    });
    if (res.status === 404) {
      // 旧版扩展没有这个接口，别再轮询
      stopTheme();
      return;
    }
    if (!res.ok) return;
    const j = await res.json();
    if (j && (j.kind === 'light' || j.kind === 'dark') && j.kind !== vsTheme) {
      vsTheme = j.kind;
      apply();
    }
  } catch (_) {
    // 扩展没在跑就当没有
  }
}

export function initTheme() {
  injected = (window.__LLM_TUNER__ && window.__LLM_TUNER__.api) || null;

  let saved = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch (_) {}
  mode = ORDER.includes(saved) ? saved : 'auto';

  mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mql) {
    const onScheme = () => {
      if (mode === 'auto' && !vsTheme) apply();
    };
    if (mql.addEventListener) mql.addEventListener('change', onScheme);
    else if (mql.addListener) mql.addListener(onScheme);
  }

  if (injected && injected.token) {
    const t = window.__LLM_TUNER__.theme;
    if (t === 'light' || t === 'dark') vsTheme = t;
    poll();
    pollTimer = setInterval(poll, 2000);
  }

  apply();
  return { mode, effective };
}

export function getMode() {
  return mode;
}

export function getEffective() {
  return effective;
}

export function getModeLabel(m = mode) {
  return LABEL[m] || m;
}

export function setMode(next) {
  if (!ORDER.includes(next)) return;
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch (_) {}
  apply();
  return mode;
}

export function cycleMode() {
  return setMode(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]);
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function stopTheme() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = 0;
}
