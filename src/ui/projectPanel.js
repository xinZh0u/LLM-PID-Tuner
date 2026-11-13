import { Project, FsDirBackend, BridgeBackend } from '../core/project.js';

const LS_KEY = 'llmtuner.bridge.v1';

export function initProject(app) {
  const $drawer = document.getElementById('projDrawer');
  const $status = document.getElementById('projStatus');
  const $count = document.getElementById('projCount');
  const $rows = document.getElementById('projRows');
  const $diff = document.getElementById('projDiff');
  const $bridgeUrl = document.getElementById('projBridgeUrl');
  const $bridgeToken = document.getElementById('projBridgeToken');

  const project = new Project(app.hub);
  app.project = project;

  // 由 VS Code 扩展托管时，页面里已经注入了桥接地址与令牌，直接预填
  const injected = typeof window !== 'undefined' && window.__LLM_TUNER__ ? window.__LLM_TUNER__ : null;
  const preset = !!(injected && injected.api && injected.api.token);

  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved) {
      if (saved.url) $bridgeUrl.value = saved.url;
      if (saved.token) $bridgeToken.value = saved.token;
    }
  } catch (_) {}

  if (preset) {
    $bridgeUrl.value = injected.api.base;
    $bridgeToken.value = injected.api.token;
  }

  document.getElementById('projBtn').addEventListener('click', async () => {
    $drawer.hidden = !$drawer.hidden;
    if ($drawer.hidden || project.backend) return;
    await tryRestore();
    if (!project.backend) await tryBridge(true);
  });
  document.getElementById('projClose').addEventListener('click', () => {
    $drawer.hidden = true;
  });

  /* ---------------- 数据来源 ---------------- */

  async function tryRestore() {
    if (!FsDirBackend.supported) {
      setStatus('当前浏览器不支持目录授权，可用 VS Code 桥接', true);
      return;
    }
    const restored = await FsDirBackend.restore();
    if (!restored) return;
    if (restored.granted) {
      await useBackend(restored.backend);
    } else {
      setStatus(`已记住 "${restored.backend.name}"，点「选择工程目录」重新授权`, true);
    }
  }

  document.getElementById('projPick').addEventListener('click', async () => {
    if (!FsDirBackend.supported) {
      setStatus('当前浏览器不支持目录授权（需要 Chrome / Edge）', true);
      return;
    }
    try {
      const backend = await FsDirBackend.pick();
      await useBackend(backend);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      setStatus('打开目录失败：' + (e.message || e), true);
    }
  });

  document.getElementById('projBridgeConnect').addEventListener('click', () => tryBridge(false));

  async function tryBridge(silent) {
    const url = $bridgeUrl.value.trim();
    const token = $bridgeToken.value.trim();
    if (!url || !token) return;
    try {
      const backend = new BridgeBackend(url, token);
      const info = await backend.ping();
      localStorage.setItem(LS_KEY, JSON.stringify({ url, token }));
      setStatus(`桥接已连接：${info.root || backend.name}`, false);
      await useBackend(backend, info.root);
    } catch (e) {
      if (!silent) setStatus('桥接连接失败：' + (e.message || e), true);
    }
  }

  async function useBackend(backend, rootLabel) {
    await project.setBackend(backend);
    setStatus(`正在扫描 ${rootLabel || backend.name} …`, false);
    await rescan();
  }

  async function rescan() {
    if (!project.backend) return;
    try {
      const r = await project.scan();
      setStatus(
        `${project.backend.name} · ${r.files} 个源文件 · ${r.params} 个 tuner_add_arg 调用`,
        false
      );
      $count.textContent = `${r.params} 个参数`;
      renderRows();
      $diff.hidden = true;
    } catch (e) {
      setStatus('扫描失败：' + (e.message || e), true);
    }
  }

  function setStatus(text, isErr) {
    $status.textContent = text;
    $status.style.color = isErr ? '#ff6b6b' : '';
  }

  document.getElementById('projRescan').addEventListener('click', rescan);

  /* ---------------- 表格 ---------------- */

  function renderRows() {
    const rows = project.rows();
    $rows.innerHTML = '';
    if (!rows.length) {
      $rows.innerHTML = '<div class="empty">源码里没有找到 tuner_add_arg(...) 调用。</div>';
      return;
    }
    const head = document.createElement('div');
    head.className = 'prow head';
    head.innerHTML = `<span class="vis-cell"></span><span class="pname">参数</span><span class="ptgt">目标变量</span><span class="pcode">代码值</span><span class="plive">在线值</span>`;
    $rows.appendChild(head);

    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'prow';
      row.dataset.name = r.name;
      const canWrite = r.hasInit && r.live !== null;
      row.innerHTML = `
        <span class="vis-cell"><input type="checkbox" class="pick" ${canWrite ? 'checked' : ''} ${r.hasInit ? '' : 'disabled'}></span>
        <span class="pname" title="${escapeAttr(r.desc)}">${escapeHtml(r.name)}</span>
        <span class="ptgt" title="${escapeAttr(r.file + ':' + r.line)}">${escapeHtml(r.target || '?')}</span>
        <span class="pcode">${r.hasInit ? escapeHtml(r.codeText) : '<i>无初始化</i>'}</span>
        <span class="plive">${r.live === null ? '--' : fmt(r.live)}</span>`;
      $rows.appendChild(row);
    }
  }

  function refreshLive() {
    if ($drawer.hidden || !project.ready) return;
    for (const row of $rows.querySelectorAll('.prow[data-name]')) {
      const name = row.dataset.name;
      const el = row.querySelector('.plive');
      const v = project.liveValue(name);
      el.textContent = v === null ? '--' : fmt(v);
    }
  }
  setInterval(refreshLive, 400);

  function selectedAssignments() {
    const list = [];
    for (const row of $rows.querySelectorAll('.prow[data-name]')) {
      const cb = row.querySelector('.pick');
      if (!cb || !cb.checked) continue;
      const name = row.dataset.name;
      const v = project.liveValue(name);
      if (v === null) continue;
      list.push({ name, value: v });
    }
    return list;
  }

  /* ---------------- 写回 ---------------- */

  let lastPlan = null;

  const sigOf = (list) => list.map((x) => x.name + '=' + x.value).join('|');

  document.getElementById('projPreview').addEventListener('click', () => {
    const list = selectedAssignments();
    if (!list.length) {
      showDiff('没有可写回的项：需要已连接下位机（或模拟源）且源码里能定位到初始化值。');
      lastPlan = null;
      return;
    }
    lastPlan = { list, sig: sigOf(list) };
    const { edits, missing } = project.plan(list);
    const parts = [];
    if (edits.length) {
      for (const e of edits) {
        parts.push(`${e.file}:${e.line}   [${e.name} → ${e.target}]\n  - ${e.oldLine}\n  + ${e.newLine}`);
      }
    } else {
      parts.push('所有勾选项的代码值已与在线值一致，无需改动。');
    }
    if (missing.length) {
      parts.push('\n未处理：\n' + missing.map((m) => `  ${m.name}: ${m.reason}`).join('\n'));
    }
    showDiff(parts.join('\n\n'));
  });

  document.getElementById('projApply').addEventListener('click', async () => {
    let list = selectedAssignments();
    if (!list.length) {
      showDiff('没有可写回的项。');
      return;
    }
    // 预览过就写预览里的那批值，避免“看到的”和“写进去的”不一致
    if (lastPlan && lastPlan.sig === sigOf(list)) list = lastPlan.list;
    try {
      const res = await project.apply(list);
      const parts = [];
      if (res.written.length) parts.push('已写入文件：\n' + res.written.map((f) => '  ' + f).join('\n'));
      if (res.edits.length) parts.push('\n' + res.edits.map((e) => `${e.file}:${e.line}\n  - ${e.oldLine}\n  + ${e.newLine}`).join('\n\n'));
      if (res.skipped.length) parts.push('\n跳过：\n' + res.skipped.map((m) => `  ${m.name}: ${m.reason}`).join('\n'));
      if (!res.edits.length) parts.push('无需改动（代码值已一致）。');
      showDiff(parts.join('\n'));
      lastPlan = null;
      renderRows();
    } catch (e) {
      showDiff('写入失败：' + (e.message || e));
    }
  });

  document.getElementById('projExport').addEventListener('click', () => {
    const params = app.hub.params
      .filter((p) => p.type !== null)
      .map((p) => ({ name: p.name, desc: p.desc, type: p.type, value: project.liveValue(p.name) }));
    const list = project.rows().map((r) => ({ name: r.name, code: r.codeValue, live: r.live, target: r.target, file: r.file, line: r.line }));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), params, codeMap: list }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'llmtuner-params.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  function showDiff(text) {
    $diff.hidden = false;
    $diff.textContent = text;
  }

  // 扩展托管时后台直接连上桥接，智能体的 find_param_code 立即可用
  if (preset) {
    setTimeout(() => {
      if (!project.backend) tryBridge(true);
    }, 800);
  }

  return { project };
}

function fmt(v) {
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(3);
  return String(Number(v.toFixed(6)));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s == null ? '' : s).replace(/'/g, '&#39;');
}
