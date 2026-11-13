import { Chart, paletteColor, remapSeriesColor, formatDuration } from './chart.js';
import { Console } from './console.js';
import { TYPE_META } from '../core/tuner.js';

const DEFAULT_VIEW = {
  win: 10,
  autoY: true,
  yMin: -1,
  yMax: 1,
  follow: true,
  grid: true,
  paused: false,
  consoleMode: 'text',
  left: 262,
  right: 288,
  consoleH: 220,
  showLeft: true,
  showRight: true,
  showConsole: true,
  autoTrans: true,
  series: {},
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];

function fmt(v, dec) {
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(dec);
}

function hexToBytes(text) {
  const clean = text.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const TEMPLATE = `
<div class="page-head">
  <span class="page-title"></span>
  <div class="page-toolbar">
    <button class="btn sm tgl" data-act="toggleLeft">串口栏</button>
    <button class="btn sm tgl" data-act="toggleRight">参数栏</button>
    <button class="btn sm tgl" data-act="toggleConsole">控制台</button>
  </div>
</div>

<aside class="pane pane-left">
  <div class="pane-sec">
    <h3>协议与连接 <span class="hint">全局共享</span></h3>
    <label class="row"><span>数据格式</span>
      <select class="fmt">
        <option value="tuner">LLM_Tuner</option>
        <option value="raw">RAW</option>
      </select>
    </label>
    <label class="row"><span>数据接口</span>
      <select disabled><option>串口 (Web Serial)</option></select>
    </label>
  </div>

  <div class="pane-sec">
    <h3>串口参数配置</h3>
    <label class="row"><span>端口</span><select class="port"></select></label>
    <button class="btn ghost sm portAdd" style="width:100%;margin-bottom:6px">授权 / 添加端口</button>
    <label class="row"><span>波特率</span><select class="baud"></select></label>
    <label class="row"><span>数据流控</span>
      <select class="flow">
        <option value="none">None</option>
        <option value="hardware">Hardware (RTS/CTS)</option>
      </select>
    </label>
    <label class="row"><span>校验位</span>
      <select class="parity">
        <option value="none">None</option>
        <option value="even">Even</option>
        <option value="odd">Odd</option>
      </select>
    </label>
    <label class="row"><span>数据位数</span>
      <select class="databits"><option>8</option><option>7</option><option>6</option><option>5</option></select>
    </label>
    <label class="row"><span>停止位数</span>
      <select class="stopbits"><option value="1">1</option><option value="2">2</option></select>
    </label>
    <div class="dtr-row">
      <label><input type="checkbox" class="dtr"> DTR</label>
      <label><input type="checkbox" class="rts"> RTS</label>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px">
      <button class="btn primary connBtn" style="flex:1">连接</button>
      <button class="btn sm resetBtn" title="清空参数表，重新接收描述包">重置参数表</button>
    </div>
  </div>

  <div class="pane-sec">
    <h3>连接状态</h3>
    <div class="stat-grid">
      <span>接收</span><b class="stRx">0 B</b>
      <span>发送</span><b class="stTx">0 B</b>
      <span>速率</span><b class="stRate">0 B/s</b>
      <span>帧率</span><b class="stFps">0 fps</b>
      <span>参数</span><b class="stParams">0</b>
      <span>CRC 错误</span><b class="stCrc">0</b>
      <span>杂散字节</span><b class="stDrop">0</b>
    </div>
    <p class="hint stErr"></p>
  </div>
</aside>

<div class="split sp-left"></div>

<section class="center">
  <div class="chart-toolbar">
    <label class="ctl">窗口 <input class="win" type="number" min="0.1" step="1"> s</label>
    <button class="btn sm act-autoY">AUTO Y</button>
    <label class="ctl"><input type="checkbox" class="grid" checked> 网格</label>
    <label class="ctl"><input type="checkbox" class="follow" checked> 跟随</label>
    <button class="btn sm act-pause">暂停</button>
    <button class="btn sm act-clear">清空</button>
    <button class="btn sm act-reset" title="恢复跟随 + 自动 Y（右键图表同效）">复位</button>
    <button class="btn sm act-clearmark" title="清除 A/B 测点（Esc 同效）">清除测点</button>
    <span class="measure-info"></span>
    <span class="chart-info"></span>
  </div>
  <div class="chart-wrap"></div>
  <div class="split split-h"></div>
  <div class="console-wrap">
    <div class="console-toolbar">
      <select class="cmode">
        <option value="text">文本</option>
        <option value="hex">Hex</option>
      </select>
      <button class="btn sm act-cpause">暂停滚动</button>
      <button class="btn sm act-cclear">清空</button>
      <span class="console-info"></span>
    </div>
    <div class="console-body"></div>
    <div class="console-send">
      <select class="sendmode">
        <option value="text">文本</option>
        <option value="hex">Hex</option>
      </select>
      <select class="eol">
        <option value="none">无</option>
        <option value="lf" selected>\\n</option>
        <option value="crlf">\\r\\n</option>
      </select>
      <input class="sendinput" placeholder="输入要发送的内容，回车发送">
      <button class="btn act-send">发送</button>
    </div>
  </div>
</section>

<div class="split sp-right"></div>

<aside class="pane pane-right">
  <div class="pane-sec right-head">
    <h3>数据 <span class="hint pcount"></span></h3>
    <div class="row-btns">
      <button class="btn xs act-all">全选</button>
      <button class="btn xs act-none">全不选</button>
    </div>
  </div>
  <div class="param-list"></div>
  <div class="empty raw-info" hidden>
    RAW 模式：不做协议解析，数据只显示在下方控制台。<br>
    切回 LLM_Tuner 即可看到参数表与波形。
  </div>
  <div class="param-editor" hidden></div>
</aside>
`;

export class Page {
  constructor(app, state) {
    this.app = app;
    this.id = state.id;
    this.title = state.title || 'new tab';
    this.format = state.format === 'raw' ? 'raw' : 'tuner';
    this.view = Object.assign({}, DEFAULT_VIEW, state.view || {});
    this.view.series = Object.assign({}, (state.view && state.view.series) || {});
    // 暂停/测点属于临时状态，不要跨会话恢复，否则重载后画面会停在空白窗口
    this.view.paused = false;
    // 新开的 Tuner 分页默认用 Hex 看串口原始帧，文本模式下二进制不可读
    if (!state.view && this.format === 'tuner') this.view.consoleMode = 'hex';
    this.active = false;
    this.selected = null;
    this.rowEls = new Map();
    this._lastVals = 0;
    this._lastConn = 0;
    this._measSig = '';
    this._offs = [];
  }

  /* ---------------- 生命周期 ---------------- */

  mount(parent) {
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.innerHTML = TEMPLATE;
    parent.appendChild(this.el);

    this.$ = (sel) => this.el.querySelector(sel);
    this.$$ = (sel) => [...this.el.querySelectorAll(sel)];

    this.$title = this.$('.page-title');
    this.$chartWrap = this.$('.chart-wrap');
    this.$consoleBody = this.$('.console-body');
    this.$paramList = this.$('.param-list');
    this.$editor = this.$('.param-editor');
    this.$count = this.$('.pcount');
    this.$rawInfo = this.$('.raw-info');

    // 本地存下来的默认调色板颜色，按当前主题换成对应色
    for (const k in this.view.series) {
      const m = this.view.series[k];
      if (m && m.color) m.color = remapSeriesColor(m.color);
    }

    this.chart = new Chart(this.$chartWrap);
    this.console2 = new Console(this.$consoleBody);

    // 图表上的拖动/缩放由 chart 自己维护状态，这里负责写回 page.view 并同步工具条
    this.chart.onViewChange = () => {
      const v = this.view;
      v.win = Math.round(this.chart.win * 1000) / 1000;
      v.follow = this.chart.follow;
      v.autoY = this.chart.autoY;
      v.yMin = this.chart.yMin;
      v.yMax = this.chart.yMax;
      this.syncChartControls();
      this.app.persist();
    };

    this.$title.textContent = this.title;
    this.$('.fmt').value = this.format;

    this._buildBauds();
    this._bind();
    this.applyLayout();
    this.applyFormat();
    this.syncSeries();
    this.renderParams();
    this.refreshConn();

    this._offs.push(this.app.hub.on('rx', (u8) => this.console2.pushRx(u8)));
    this._offs.push(this.app.conn.on('tx', (u8) => this.console2.pushTx(u8)));
    this._offs.push(this.app.hub.on('params', () => {
      this.syncSeries();
      this.renderParams();
    }));
    this._offs.push(this.app.hub.on('cleared', () => {
      this.chart.clearView();
      this.updateValues();
    }));
    this._offs.push(this.app.conn.on('state', () => this.refreshConn()));
    this._offs.push(this.app.conn.on('ports', () => this.refreshConn()));

    return this.el;
  }

  unmount() {
    for (const off of this._offs) off();
    this._offs = [];
    this.chart.destroy();
    this.el.remove();
  }

  setActive(on) {
    this.active = on;
    this.el.classList.toggle('active', on);
    if (on) {
      requestAnimationFrame(() => {
        this.chart.resize();
        this.refreshConn();
      });
    }
  }

  /* ---------------- 布局 ---------------- */

  applyLayout() {
    const v = this.view;
    this.el.style.setProperty('--left', (v.showLeft ? v.left : 0) + 'px');
    this.el.style.setProperty('--right', (v.showRight ? v.right : 0) + 'px');
    this.el.style.setProperty('--console', (v.showConsole ? v.consoleH : 0) + 'px');
    this.el.classList.toggle('no-left', !v.showLeft);
    this.el.classList.toggle('no-right', !v.showRight);
    this.el.classList.toggle('no-console', !v.showConsole);
    this.$('[data-act="toggleLeft"]').classList.toggle('active', v.showLeft);
    this.$('[data-act="toggleRight"]').classList.toggle('active', v.showRight);
    this.$('[data-act="toggleConsole"]').classList.toggle('active', v.showConsole);
  }

  syncChartControls() {
    const v = this.view;
    const winInput = this.$('.win');
    if (document.activeElement !== winInput) winInput.value = String(v.win);
    this.$('.follow').checked = v.follow;
    this.$('.act-autoY').classList.toggle('active', !v.autoY);
  }

  _bindSplitter(el, kind) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const sx = e.clientX;
      const sy = e.clientY;
      const v = this.view;
      const base = { left: v.left, right: v.right, consoleH: v.consoleH };
      const move = (ev) => {
        if (kind === 'left') v.left = clamp(base.left + (ev.clientX - sx), 190, 560);
        else if (kind === 'right') v.right = clamp(base.right - (ev.clientX - sx), 190, 620);
        else v.consoleH = clamp(base.consoleH - (ev.clientY - sy), 70, Math.max(120, this.el.clientHeight - 180));
        this.applyLayout();
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.app.persist();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  _bind() {
    this._bindSplitter(this.$('.sp-left'), 'left');
    this._bindSplitter(this.$('.sp-right'), 'right');
    this._bindSplitter(this.$('.split-h'), 'console');

    this.$('.page-toolbar').addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      if (act === 'toggleLeft') this.view.showLeft = !this.view.showLeft;
      if (act === 'toggleRight') this.view.showRight = !this.view.showRight;
      if (act === 'toggleConsole') this.view.showConsole = !this.view.showConsole;
      this.applyLayout();
      this.app.persist();
    });

    this.$('.fmt').addEventListener('change', (e) => {
      this.format = e.target.value;
      this.applyFormat();
      this.app.persist();
      this.app.emit('format', this);
      this.app.scheduleTransSync();
    });

    // ---- 串口面板 ----
    const conn = this.app.conn;
    const $port = this.$('.port');

    this.$('.portAdd').addEventListener('click', async () => {
      try {
        const key = await conn.requestPort();
        $port.value = key;
        this.app.persist();
      } catch (err) {
        if (err && err.name !== 'NotFoundError') console.warn(err);
      }
    });

    $port.addEventListener('change', () => {
      conn.portKey = $port.value;
      this.app.persist();
    });

    this.$('.baud').addEventListener('change', (e) => {
      conn.setOpts({ baudRate: Number(e.target.value) });
      this.app.persist();
    });
    this.$('.flow').addEventListener('change', (e) => {
      conn.setOpts({ flowControl: e.target.value });
      this.app.persist();
    });
    this.$('.parity').addEventListener('change', (e) => {
      conn.setOpts({ parity: e.target.value });
      this.app.persist();
    });
    this.$('.databits').addEventListener('change', (e) => {
      conn.setOpts({ dataBits: Number(e.target.value) });
      this.app.persist();
    });
    this.$('.stopbits').addEventListener('change', (e) => {
      conn.setOpts({ stopBits: Number(e.target.value) });
      this.app.persist();
    });
    this.$('.dtr').addEventListener('change', (e) => conn.setSignals({ dataTerminalReady: e.target.checked }));
    this.$('.rts').addEventListener('change', (e) => conn.setSignals({ requestToSend: e.target.checked }));

    this.$('.connBtn').addEventListener('click', async () => {
      if (this.app.conn.connected) await this.app.conn.disconnect();
      else await this.app.conn.connect();
      this.app.scheduleTransSync();
    });

    this.$('.resetBtn').addEventListener('click', () => {
      this.app.hub.reset();
      this.app.hub.beginSession();
      this.view.series = {};
      this.selected = null;
      this.renderParams();
      this.app.persist();
    });

    // ---- 图表工具条 ----
    const v = this.view;
    this.$('.win').value = v.win;
    this.$('.win').addEventListener('change', (e) => {
      v.win = Math.max(0.1, Number(e.target.value) || 10);
      this.app.persist();
    });
    this.$('.act-autoY').addEventListener('click', () => {
      v.autoY = !v.autoY;
      this.$('.act-autoY').classList.toggle('active', !v.autoY);
      this.app.persist();
    });
    this.$('.grid').checked = v.grid;
    this.$('.grid').addEventListener('change', (e) => {
      v.grid = e.target.checked;
      this.app.persist();
    });
    this.$('.follow').checked = v.follow;
    this.$('.follow').addEventListener('change', (e) => {
      v.follow = e.target.checked;
      this.chart.follow = v.follow;
      this.app.persist();
    });
    this.$('.act-pause').addEventListener('click', () => {
      v.paused = !v.paused;
      this.chart.paused = v.paused;
      this.$('.act-pause').classList.toggle('active', v.paused);
      this.$('.act-pause').textContent = v.paused ? '继续' : '暂停';
      // 暂停时把窗口贴到最后一批数据，画面不会停在半截
      if (v.paused) this.chart.snapToData();
    });
    this.$('.act-clear').addEventListener('click', () => {
      this.app.hub.clearData();
      this.chart.clearMarkers();
      this.chart.clearView();
      this.chart.follow = true;
      v.follow = true;
      this.$('.follow').checked = true;
      this.syncChartControls();
    });
    this.$('.act-reset').addEventListener('click', () => {
      this.chart.resetView();
      this.syncChartControls();
      this.app.persist();
    });
    this.$('.act-clearmark').addEventListener('click', () => {
      this.chart.clearMarkers();
    });

    // ---- 控制台 ----
    const $cmode = this.$('.cmode');
    $cmode.value = v.consoleMode;
    this.console2.setMode(v.consoleMode);
    $cmode.addEventListener('change', (e) => {
      v.consoleMode = e.target.value;
      this.console2.setMode(v.consoleMode);
      this.app.persist();
    });
    this.$('.act-cpause').addEventListener('click', (e) => {
      const paused = !this.console2.paused;
      this.console2.setPaused(paused);
      e.target.classList.toggle('active', paused);
      e.target.textContent = paused ? '继续滚动' : '暂停滚动';
    });
    this.$('.act-cclear').addEventListener('click', () => this.console2.clear());

    this.$('.sendinput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.send();
      }
    });
    this.$('.act-send').addEventListener('click', () => this.send());

    // ---- 右侧参数栏 ----
    this.$('.act-all').addEventListener('click', () => this.setAllVisible(true));
    this.$('.act-none').addEventListener('click', () => this.setAllVisible(false));

    this.$paramList.addEventListener('click', (e) => {
      const row = e.target.closest('.prow');
      if (!row) return;
      const idx = Number(row.dataset.index);
      if (e.target.classList.contains('vis')) {
        const m = this.seriesOf(idx);
        m.visible = e.target.checked;
        row.classList.toggle('unplotted', !m.visible);
        this.app.scheduleTransSync();
        this.app.persist();
        return;
      }
      this.selectParam(idx);
    });
  }

  _buildBauds() {
    const sel = this.$('.baud');
    const cur = this.app.conn.opts.baudRate;
    const list = BAUDS.includes(cur) ? BAUDS : [...BAUDS, cur].sort((a, b) => a - b);
    sel.innerHTML = list.map((b) => `<option value="${b}">${b}</option>`).join('');
    sel.value = String(cur);
  }

  /* ---------------- 格式 ---------------- */

  applyFormat() {
    const isTuner = this.format === 'tuner';
    this.$('.fmt').value = this.format;
    this.$paramList.hidden = !isTuner;
    this.$rawInfo.hidden = isTuner;
    this.$('.right-head').hidden = !isTuner;
    if (!isTuner) {
      this.$editor.hidden = true;
      this.selected = null;
    }
    this.$('.act-all').disabled = !isTuner;
    this.$('.act-none').disabled = !isTuner;
    this.app.renderTabs();
  }

  /* ---------------- 参数 ---------------- */

  seriesOf(index, autoCreate = true) {
    let m = this.view.series[index];
    if (m) {
      if (m.gain === undefined) m.gain = 1;
      if (m.offset === undefined) m.offset = 0;
      if (m.decimals === undefined) m.decimals = 3;
      return m;
    }
    if (!autoCreate) return null;
    const p = this.app.hub.params[index];
    const dec = p && p.type !== null ? TYPE_META[p.type].decimals : 3;
    let visibleCount = 0;
    for (const k in this.view.series) if (this.view.series[k].visible) visibleCount++;
    m = {
      visible: visibleCount < 4,
      color: paletteColor(index),
      name: '',
      gain: 1,
      offset: 0,
      decimals: dec,
    };
    this.view.series[index] = m;
    return m;
  }

  syncSeries() {
    for (let i = 0; i < this.app.hub.params.length; i++) this.seriesOf(i);
  }

  visibleIndices() {
    const out = [];
    for (let i = 0; i < this.app.hub.params.length; i++) {
      const m = this.view.series[i];
      if (m && m.visible) out.push(i);
    }
    return out;
  }

  setAllVisible(on) {
    for (let i = 0; i < this.app.hub.params.length; i++) this.seriesOf(i).visible = on;
    this.renderParams();
    this.app.scheduleTransSync();
    this.app.persist();
  }

  renderParams() {
    const hub = this.app.hub;
    this.$paramList.innerHTML = '';
    this.rowEls.clear();
    if (!hub.params.length) {
      this.$count.textContent = '0';
      if (this.format === 'tuner') {
        const div = document.createElement('div');
        div.className = 'empty';
        div.textContent = '等待下位机描述包…（下位机需调用 tuner_send_desc）';
        this.$paramList.appendChild(div);
      }
      return;
    }
    this.$count.textContent = String(hub.params.length);

    const frag = document.createDocumentFragment();
    hub.params.forEach((p) => {
      const m = this.seriesOf(p.index);
      const row = document.createElement('div');
      row.className = 'prow' + (m.visible ? '' : ' unplotted') + (this.selected === p.index ? ' sel' : '');
      row.dataset.index = String(p.index);
      const tag = p.type === null ? '?' : TYPE_META[p.type].key;
      row.title = `${p.name || '#' + p.index} (${tag})\n${p.desc || ''}`;
      row.innerHTML = `
        <input type="checkbox" class="vis" ${m.visible ? 'checked' : ''}>
        <span class="dot" style="background:${m.color}"></span>
        <span class="pname"></span>
        <span class="pval"></span>`;
      row.querySelector('.pname').textContent = m.name || p.name || '#' + p.index;
      frag.appendChild(row);
      this.rowEls.set(p.index, { row, val: row.querySelector('.pval') });
    });
    this.$paramList.appendChild(frag);
    this.updateValues();
  }

  updateValues() {
    const hub = this.app.hub;
    for (const [idx, refs] of this.rowEls) {
      const p = hub.params[idx];
      if (!p) continue;
      const m = this.seriesOf(idx, false);
      const dec = m ? m.decimals : 3;
      refs.val.textContent = fmt(p.ring.last(), dec);
    }
    if (this.selected !== null && this.$editor.hidden === false) {
      const p = hub.params[this.selected];
      if (p) this.$editor.querySelector('.ed-now').textContent = '当前：' + fmt(p.ring.last(), this.seriesOf(this.selected).decimals);
    }
  }

  selectParam(index) {
    this.selected = index;
    for (const [idx, refs] of this.rowEls) refs.row.classList.toggle('sel', idx === index);
    this.renderEditor();
  }

  renderEditor() {
    const idx = this.selected;
    const hub = this.app.hub;
    const p = idx !== null ? hub.params[idx] : null;
    if (!p) {
      this.$editor.hidden = true;
      return;
    }
    const m = this.seriesOf(idx);
    const dec = m.decimals;
    const typeLabel = p.type === null ? '未知' : TYPE_META[p.type].label;
    this.$editor.hidden = false;
    this.$editor.innerHTML = `
      <div class="ed-head">#${idx}<span class="tag">${typeLabel}</span>
        <span class="tag">${p.writable ? '可写' : '只读'}</span>
        <span class="grow"></span></div>
      <label class="erow"><span>显示名</span><input class="ed-name" placeholder="${p.name || ''}"></label>
      <label class="erow"><span>颜色</span><input type="color" class="ed-color"></label>
      <label class="erow"><span>增益</span><input type="number" class="ed-gain" step="any"></label>
      <label class="erow"><span>偏移</span><input type="number" class="ed-offset" step="any"></label>
      <label class="erow"><span>小数位</span><input type="number" class="ed-dec" min="0" max="8" step="1"></label>
      <label class="erow"><span>写入值</span><input class="ed-val" placeholder="输入数值后回车"></label>
      <div class="ed-desc"></div>
      <div class="ed-now"></div>`;

    const $name = this.$editor.querySelector('.ed-name');
    const $color = this.$editor.querySelector('.ed-color');
    const $gain = this.$editor.querySelector('.ed-gain');
    const $offset = this.$editor.querySelector('.ed-offset');
    const $decInput = this.$editor.querySelector('.ed-dec');
    const $val = this.$editor.querySelector('.ed-val');
    const $desc = this.$editor.querySelector('.ed-desc');
    const $now = this.$editor.querySelector('.ed-now');

    $name.value = m.name || '';
    $color.value = m.color;
    $gain.value = m.gain;
    $offset.value = m.offset;
    $decInput.value = dec;
    $desc.textContent = p.desc || '';
    $now.textContent = '当前：' + fmt(p.ring.last(), dec);

    const commit = () => {
      m.name = $name.value.trim();
      m.color = $color.value;
      m.gain = Number($gain.value) || 0;
      m.offset = Number($offset.value) || 0;
      m.decimals = Math.max(0, Math.min(8, Number($decInput.value) || 0));
      const refs = this.rowEls.get(idx);
      if (refs) {
        refs.row.querySelector('.pname').textContent = m.name || p.name || '#' + idx;
        refs.row.querySelector('.dot').style.background = m.color;
        refs.val.textContent = fmt(p.ring.last(), m.decimals);
      }
      this.updateValues();
      this.app.persist();
    };
    $name.addEventListener('input', commit);
    $color.addEventListener('input', commit);
    $gain.addEventListener('change', commit);
    $offset.addEventListener('change', commit);
    $decInput.addEventListener('change', commit);
    $val.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      this.writeValue($val);
    });
  }

  writeValue(input) {
    const idx = this.selected;
    const p = idx !== null ? this.app.hub.params[idx] : null;
    if (!p) return;
    if (p.type === null) return;
    const raw = input.value.trim();
    if (!raw) return;
    let value;
    if (/^0x[0-9a-f]+$/i.test(raw)) value = parseInt(raw, 16);
    else value = Number(raw);
    if (!Number.isFinite(value)) {
      input.classList.add('bad');
      setTimeout(() => input.classList.remove('bad'), 600);
      return;
    }
    if (TYPE_META[p.type].integer) value = Math.trunc(value);
    this.app.hub.sendTuning(idx, value);
    const $now = this.$editor.querySelector('.ed-now');
    if ($now) $now.textContent = '已发送 → ' + value;
  }

  /* ---------------- 发送 ---------------- */

  send() {
    const $input = this.$('.sendinput');
    const raw = $input.value;
    if (!raw) return;
    const mode = this.$('.sendmode').value;
    const eolKey = this.$('.eol').value;
    let bytes;
    if (mode === 'hex') {
      bytes = hexToBytes(raw);
      if (!bytes) {
        $input.classList.add('bad');
        setTimeout(() => $input.classList.remove('bad'), 600);
        return;
      }
    } else {
      const eol = eolKey === 'crlf' ? '\r\n' : eolKey === 'lf' ? '\n' : '';
      bytes = new TextEncoder().encode(raw + eol);
    }
    this.app.conn.write(bytes);
  }

  /* ---------------- 串口面板刷新 ---------------- */

  refreshConn() {
    if (!this.el) return;
    const conn = this.app.conn;
    const hub = this.app.hub;
    const connected = conn.connected;

    const $port = this.$('.port');
    const opts = [{ v: 'mock', t: '模拟数据源（无需硬件）' }];
    conn.ports.forEach((p, i) => opts.push({ v: 'p' + i, t: conn.portLabel(p, i) }));
    const key = conn.portKey;
    const sig = opts.map((o) => o.v).join(',') + '|' + key;
    if (this._portSig !== sig) {
      this._portSig = sig;
      $port.innerHTML = opts.map((o) => `<option value="${o.v}">${o.t}</option>`).join('');
    }
    if (!opts.some((o) => o.v === key)) {
      const add = document.createElement('option');
      add.value = key;
      add.textContent = key;
      $port.appendChild(add);
    }
    $port.value = key;
    $port.disabled = connected;

    this.$('.baud').value = String(conn.opts.baudRate);
    this.$('.flow').value = conn.opts.flowControl;
    this.$('.parity').value = conn.opts.parity;
    this.$('.databits').value = String(conn.opts.dataBits);
    this.$('.stopbits').value = String(conn.opts.stopBits);
    this.$('.dtr').checked = conn.signals.dataTerminalReady;
    this.$('.rts').checked = conn.signals.requestToSend;

    ['.baud', '.flow', '.parity', '.databits', '.stopbits', '.portAdd'].forEach((s) => {
      this.$(s).disabled = connected;
    });

    const btn = this.$('.connBtn');
    if (conn.status === 'connecting') {
      btn.textContent = '连接中…';
      btn.disabled = true;
    } else if (connected) {
      btn.textContent = '断开';
      btn.disabled = false;
      btn.classList.remove('primary');
      btn.classList.add('ghost');
    } else {
      btn.textContent = '连接';
      btn.disabled = false;
      btn.classList.add('primary');
      btn.classList.remove('ghost');
    }

    const s = hub.stats;
    this.$('.stRx').textContent = fmtBytes(s.rx);
    this.$('.stTx').textContent = fmtBytes(s.tx);
    this.$('.stRate').textContent = fmtBytes(s.rate) + '/s';
    this.$('.stFps').textContent = s.frameRate + ' fps';
    this.$('.stParams').textContent = String(hub.params.length);
    this.$('.stCrc').textContent = String(s.crcErrors);
    this.$('.stDrop').textContent = String(s.dropped);
    this.$('.stErr').textContent = conn.error
      ? '错误：' + conn.error
      : !conn.supported
      ? '当前浏览器不支持 Web Serial，可使用模拟数据源。'
      : '';
    this.$('.stErr').style.color = conn.error ? '#ff6b6b' : '';

    const info = this.$('.chart-info');
    if (info) {
      const n = this.visibleIndices().length;
      info.textContent =
        this.format === 'raw'
          ? `RAW · ${fmtBytes(s.rx)} · ${fmtBytes(s.rate)}/s`
          : `${n} 条曲线 · ${fmtBytes(s.rate)}/s`;
    }
  }

  /* ---------------- 每帧刷新 ---------------- */

  tick(nowMs) {
    if (!this.active) return;
    this.console2.flush();

    const v = this.view;
    this.chart.win = v.win;
    this.chart.follow = v.follow;
    this.chart.autoY = v.autoY;
    this.chart.yMin = v.yMin;
    this.chart.yMax = v.yMax;
    this.chart.grid = v.grid;
    this.chart.paused = v.paused;
    if (!v.autoY) {
      v.yMin = this.chart.yMin;
      v.yMax = this.chart.yMax;
    }

    if (this.format === 'tuner') {
      this.chart.host.style.display = '';
      this.chart.render(this.chartSeries(), this.app.hub.now());
    } else {
      this.drawRawState();
    }

    const m = this.chart.measure();
    const markers = this.chart.markers.length;
    const sig = m ? `${m.dt}|${m.dy}` : markers ? 'A' : '';
    if (sig !== this._measSig) {
      this._measSig = sig;
      const el = this.$('.measure-info');
      if (m) {
        el.textContent =
          `A→B Δt ${formatDuration(m.dt)}` + (m.dy === null ? '' : `  Δy ${m.dy >= 0 ? '+' : ''}${m.dy.toFixed(3)}`);
      } else if (markers === 1) {
        el.textContent = '已选 A 点，再双击选 B';
      } else {
        el.textContent = '';
      }
    }

    if (nowMs - this._lastVals > 120) {
      this._lastVals = nowMs;
      this.updateValues();
      if (nowMs - this._lastConn > 500) {
        this._lastConn = nowMs;
        this.refreshConn();
      }
    }
  }

  drawRawState() {
    const ctx = this.chart.ctx;
    const W = this.chart.w;
    const H = this.chart.h;
    const c = this.chart.dpr;
    const th = this.chart.theme;
    ctx.setTransform(c, 0, 0, c, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = th.axis;
    ctx.font = '12px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const s = this.app.hub.stats;
    ctx.fillText('RAW 模式 · 数据见下方控制台', W / 2, H / 2 - 12);
    ctx.fillText(`${fmtBytes(s.rx)} 已接收 · ${fmtBytes(s.rate)}/s`, W / 2, H / 2 + 8);
  }

  /** 主题切换：重新取画布配色，并把默认调色板的曲线换成对应主题的色 */
  onThemeChange() {
    this.chart.refreshTheme();
    for (const k in this.view.series) {
      const m = this.view.series[k];
      m.color = remapSeriesColor(m.color);
    }
    this.renderParams();
    if (this.selected !== null) this.renderEditor();
    this.tick(performance.now());
  }

  chartSeries() {
    const out = [];
    const hub = this.app.hub;
    for (let i = 0; i < hub.params.length; i++) {
      const p = hub.params[i];
      if (p.type === null) continue;
      const m = this.view.series[i];
      if (!m || !m.visible) continue;
      out.push({
        name: m.name || p.name || '#' + i,
        color: m.color,
        gain: m.gain,
        offset: m.offset,
        decimals: m.decimals,
        ring: p.ring,
      });
    }
    return out;
  }

  /* ---------------- 持久化 ---------------- */

  toState() {
    return {
      id: this.id,
      title: this.title,
      format: this.format,
      view: this.view,
    };
  }

  setTitle(t) {
    this.title = t;
    this.$title.textContent = t;
    this.app.renderTabs();
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}
