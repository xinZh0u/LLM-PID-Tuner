const DARK_PALETTE = [
  '#2fd6b6', '#ff5c8a', '#7aa2ff', '#ffc247', '#a889ff',
  '#4fd1ff', '#ff8a5c', '#7ee787', '#ff6bd6', '#c9d1d9',
];
const LIGHT_PALETTE = [
  '#0d9c8b', '#d63f74', '#2f6fdd', '#b07600', '#7a51d8',
  '#0b83b3', '#cc5a20', '#2f8f43', '#b83b96', '#5b6472',
];

let paletteTheme = 'dark';

export function setPaletteTheme(name) {
  paletteTheme = name === 'light' ? 'light' : 'dark';
}

export function paletteColor(i) {
  const p = paletteTheme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  return p[i % p.length];
}

/** 切换主题时把"还是默认调色板"的曲线换个对应颜色，用户自定义的颜色不动 */
export function remapSeriesColor(color) {
  const c = String(color || '').toLowerCase();
  const from = paletteTheme === 'light' ? DARK_PALETTE : LIGHT_PALETTE;
  const to = paletteTheme === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
  const i = from.findIndex((x) => x.toLowerCase() === c);
  return i >= 0 ? to[i] : color;
}

function readThemeColors(el) {
  const cs = getComputedStyle(el);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    bg: v('--chart-bg', '#0e1218'),
    grid: v('--chart-grid', '#1e2733'),
    border: v('--chart-border', '#2a3542'),
    axis: v('--chart-axis', '#6f7d90'),
    legendBg: v('--chart-legend-bg', 'rgba(14,18,24,.66)'),
    legendText: v('--chart-legend-text', '#c7d2e1'),
    cross: v('--chart-crosshair', 'rgba(255,255,255,.28)'),
    tipBg: v('--chart-tip-bg', 'rgba(20,26,34,.94)'),
    tipBorder: v('--chart-tip-border', '#33404f'),
    hint: v('--chart-hint', '#7e8b9d'),
    warn: v('--warn', '#f5a623'),
  };
}

/**
 * VOFA 风格折线图：时间轴滚动窗口 + 自动 Y + 逐像素列抽稀。
 */
export class Chart {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.win = 10;
    this.follow = true;
    this.autoY = true;
    this.yMin = -1;
    this.yMax = 1;
    this.grid = true;
    this.paused = false;

    this.endT = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = 300;
    this.h = 160;
    this.hover = null;
    this._drag = null;
    this._ro = null;
    this.theme = readThemeColors(host);
    this.markers = [];
    this._plot = null;
    this._last = null;
    /** 用户改动了视图（win / endT / autoY / follow / yMin,yMax）时回调，供上层写回 page.view */
    this.onViewChange = null;

    const resize = () => this.resize();
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(resize);
      this._ro.observe(host);
    } else {
      window.addEventListener('resize', resize);
    }
    this._bindEvents();
    this.resize();
  }

  destroy() {
    this._ro?.disconnect();
    if (this._onKey) window.removeEventListener('keydown', this._onKey);
  }

  /** 主题切换后重新取色并重绘 */
  refreshTheme() {
    this.theme = readThemeColors(this.host);
    if (this._last) this.render(this._last.series, this._last.nowT);
  }

  resize() {
    const rect = this.host.getBoundingClientRect();
    const w = Math.max(80, Math.round(rect.width));
    const h = Math.max(60, Math.round(rect.height));
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    // 改尺寸会清空画布，立即用上一帧数据补画，避免隐藏标签页 rAF 暂停时白屏
    if (this._last) this.render(this._last.series, this._last.nowT);
  }

  setWindow(sec) {
    this.win = Math.max(0.1, Number(sec) || 1);
  }

  clearView() {
    this.endT = 0;
  }

  /* ---------------- 视图辅助 ---------------- */

  _plotRect() {
    const padL = 46;
    const padT = 10;
    const pw = Math.max(10, this.w - padL - 14);
    const ph = Math.max(10, this.h - padT - 22);
    return { padL, padT, pw, ph };
  }

  _notifyView() {
    if (typeof this.onViewChange === 'function') this.onViewChange();
    if (this._last) this.render(this._last.series, this._last.nowT);
  }

  /** 恢复跟随 + 自动 Y */
  resetView() {
    this.follow = true;
    this.autoY = true;
    this._notifyView();
  }

  /** 把窗口右端贴到最后一批数据（暂停时用，保证暂停瞬间的画面包含全部数据） */
  snapToData() {
    const max = this._dataMax;
    if (!Number.isFinite(max)) return;
    if (max > this.endT) {
      this.endT = max;
      this._notifyView();
    }
  }

  clearMarkers() {
    if (!this.markers.length) return;
    this.markers = [];
    this._notifyView();
  }

  /** 两点测时结果 */
  measure() {
    if (this.markers.length < 2) return null;
    const [a, b] = this.markers;
    return {
      dt: Math.abs(b.t - a.t),
      dy: a.name === b.name ? b.v - a.v : null,
      a,
      b,
    };
  }

  _pickPoint(x, y) {
    const plot = this._plot;
    if (!plot || !this._last) return null;
    const { padL, padT, pw, ph, tStart, lo, hi } = plot;
    const t = tStart + ((x - padL) / pw) * this.win;
    const span = hi - lo || 1;
    let best = null;
    let bestD = 40 * 40;
    for (const s of this._last.series) {
      const ring = s.ring;
      if (!ring || !ring.count) continue;
      const gain = s.gain === undefined || s.gain === null ? 1 : s.gain;
      const offset = s.offset || 0;
      const i0 = ring.indexAt(t);
      const from = Math.max(0, i0 - 12);
      const to = Math.min(ring.count - 1, i0 + 12);
      for (let k = from; k <= to; k++) {
        const px = padL + ((ring.tAt(k) - tStart) / this.win) * pw;
        const py = padT + ph - ((ring.vAt(k) * gain + offset - lo) / span) * ph;
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < bestD) {
          bestD = d;
          best = {
            t: ring.tAt(k),
            v: ring.vAt(k) * gain + offset,
            name: s.name,
            color: s.color,
            decimals: s.decimals,
          };
        }
      }
    }
    return best;
  }

  _pickAt(x, y) {
    const { padL, padT, pw, ph } = this._plotRect();
    if (x < padL || x > padL + pw || y < padT || y > padT + ph) return false;
    const p = this._pickPoint(x, y);
    if (!p) return false;
    if (this.markers.length >= 2) this.markers = [];
    this.markers = this.markers.length ? [this.markers[0], p] : [p];
    this._notifyView();
    return true;
  }

  _bindEvents() {
    const el = this.canvas;

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const { padL, padT, pw, ph } = this._plotRect();
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const zoomX = !(e.altKey || e.ctrlKey);
      const zoomY = !e.shiftKey;

      if (zoomX) {
        const frac = Math.min(1, Math.max(0, (x - padL) / pw));
        const tAtCursor = this.endT - this.win + frac * this.win;
        this.win = Math.min(3600, Math.max(0.01, this.win * factor));
        if (!this.follow) this.endT = tAtCursor + (1 - frac) * this.win;
      }

      if (zoomY && this._plot) {
        const span = this._plot.hi - this._plot.lo || 1;
        const frac = Math.min(1, Math.max(0, (y - padT) / ph));
        const vAt = this._plot.hi - frac * span;
        const newSpan = Math.max(1e-9, span * factor);
        this.autoY = false;
        this.yMin = vAt - (1 - frac) * newSpan;
        this.yMax = vAt + frac * newSpan;
      }

      this._notifyView();
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (_) {}
      const range = this._plot || { lo: this.yMin, hi: this.yMax };
      this._drag = {
        x: e.clientX,
        y: e.clientY,
        endT: this.endT,
        yLo: range.lo,
        yHi: range.hi,
        active: false,
      };
    });

    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const d = this._drag;
      if (!d) return;

      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.active) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        d.active = true;
        this.follow = false;
        el.style.cursor = 'grabbing';
      }

      const { pw, ph } = this._plotRect();
      this.endT = d.endT - (dx / pw) * this.win;

      // 纵向拖动：冻结当前 Y 范围后整体平移
      if (Math.abs(dy) >= 3) {
        const span = d.yHi - d.yLo || 1;
        const shift = (dy / ph) * span;
        this.autoY = false;
        this.yMin = d.yLo + shift;
        this.yMax = d.yHi + shift;
      }
      this._notifyView();
    });

    const up = () => {
      if (this._drag) {
        this._drag = null;
        el.style.cursor = '';
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => {
      this.hover = null;
    });

    el.addEventListener('dblclick', (e) => {
      const rect = el.getBoundingClientRect();
      this._pickAt(e.clientX - rect.left, e.clientY - rect.top);
    });

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.resetView();
    });

    this._onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (this.markers.length) this.clearMarkers();
      else this.resetView();
    };
    window.addEventListener('keydown', this._onKey);
  }

  /**
   * @param {Array} series [{name,color,gain,offset,decimals,ring}]
   * @param {number} nowT 当前时间（秒）
   */
  render(series, nowT) {
    this._last = { series, nowT };
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    const th = this.theme;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);

    const padL = 46;
    const padR = 14;
    const padT = 10;
    const padB = 22;
    const pw = Math.max(10, W - padL - padR);
    const ph = Math.max(10, H - padT - padB);

    // ---------- 数据时间域 ----------
    // 窗口必须钉在数据上：断开连接 / 下位机停发后若还按真实时间往前滑，
    // 窗口就会滑出数据区，整屏变空白（"断开后波形消失"就是这个原因）
    let dataMin = Infinity;
    let dataMax = -Infinity;
    for (const s of series) {
      const r = s.ring;
      if (!r || !r.count) continue;
      const f = r.tAt(0);
      const l = r.lastT();
      if (f < dataMin) dataMin = f;
      if (l > dataMax) dataMax = l;
    }
    const hasData = Number.isFinite(dataMax);
    this._dataMax = hasData ? dataMax : NaN;

    if (this.endT === 0) this.endT = nowT;
    if (hasData) {
      const limit = this.follow && !this.paused ? nowT : this.endT;
      // 允许一点点余量，但最多不超过窗口的 1%，避免数据停后画面滑走
      this.endT = Math.min(limit, dataMax + Math.min(0.02, this.win * 0.01));
      if (this.endT < dataMin) this.endT = dataMin + this.win * 0.5;
    } else if (this.follow && !this.paused) {
      this.endT = nowT;
    }
    const tEnd = this.endT;
    const tStart = tEnd - this.win;

    // ---------- Y 范围 ----------
    let lo = Infinity;
    let hi = -Infinity;
    const view = [];
    for (const s of series) {
      const ring = s.ring;
      if (!ring || ring.count === 0) continue;
      const i0 = ring.indexAt(tStart);
      // indexAt 可能返回 count（窗口右端超出最后一个采样），必须夹住，
      // 否则会读到环形缓冲的“下一写入槽”里的旧值，画出一条横穿全图的假线
      const i1 = Math.min(ring.count, ring.indexAt(tEnd) + 1);
      if (i1 <= i0) continue;
      const gain = s.gain === undefined || s.gain === null ? 1 : s.gain;
      const offset = s.offset || 0;
      for (let i = i0; i < i1; i++) {
        const v = ring.vAt(i) * gain + offset;
        if (!Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      view.push({ s, i0, i1, gain, offset });
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = this.autoY ? -1 : this.yMin;
      hi = this.autoY ? 1 : this.yMax;
    }
    if (this.autoY) {
      if (hi - lo < 1e-9) {
        const mid = (hi + lo) / 2;
        lo = mid - 1;
        hi = mid + 1;
      } else {
        const pad = (hi - lo) * 0.08;
        lo -= pad;
        hi += pad;
      }
      this.yMin = lo;
      this.yMax = hi;
    } else {
      lo = this.yMin;
      hi = this.yMax;
    }

    const xOf = (t) => padL + ((t - tStart) / this.win) * pw;
    const yOf = (v) => padT + ph - ((v - lo) / (hi - lo)) * ph;

    // 供命中测试（双击选点）使用
    this._plot = { padL, padT, pw, ph, tStart, lo, hi };

    // ---------- 网格 ----------
    if (this.grid) {
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const yTicks = 5;
      for (let i = 0; i <= yTicks; i++) {
        const y = Math.round(padT + (ph * i) / yTicks) + 0.5;
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + pw, y);
      }
      const xTicks = 6;
      for (let i = 0; i <= xTicks; i++) {
        const x = Math.round(padL + (pw * i) / xTicks) + 0.5;
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + ph);
      }
      ctx.stroke();

      // Y 轴刻度
      ctx.fillStyle = th.axis;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= yTicks; i++) {
        const y = padT + (ph * i) / yTicks;
        const v = hi - ((hi - lo) * i) / yTicks;
        ctx.fillText(formatTick(v), padL - 6, y);
      }

      // X 轴刻度
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i <= xTicks; i++) {
        const x = padL + (pw * i) / xTicks;
        const t = tStart + (this.win * i) / xTicks;
        const rel = t - tEnd;
        ctx.fillText(rel.toFixed(2) + 's', x, padT + ph + 5);
      }
    }

    // 绘图区裁剪
    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, pw, ph);
    ctx.clip();

    // ---------- 曲线 ----------
    for (const { s, i0, i1, gain, offset } of view) {
      const ring = s.ring;
      const n = i1 - i0;
      ctx.strokeStyle = s.color || paletteColor(0);
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (n <= pw * 2) {
        for (let i = i0; i < i1; i++) {
          const x = xOf(ring.tAt(i));
          const y = yOf(ring.vAt(i) * gain + offset);
          if (i === i0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      } else {
        // 逐像素列抽稀：每列保留 min/max，避免混叠
        let col = -1;
        let minY = 0;
        let maxY = 0;
        for (let i = i0; i < i1; i++) {
          const x = xOf(ring.tAt(i));
          const c = Math.round(x - padL);
          const y = yOf(ring.vAt(i) * gain + offset);
          if (c !== col) {
            if (col >= 0) {
              ctx.moveTo(padL + col + 0.5, minY);
              ctx.lineTo(padL + col + 0.5, maxY);
            }
            col = c;
            minY = y;
            maxY = y;
          } else {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        if (col >= 0) {
          ctx.moveTo(padL + col + 0.5, minY);
          ctx.lineTo(padL + col + 0.5, maxY);
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    // 边框
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, pw, ph);

    // ---------- 图例 ----------
    let lx = padL + 6;
    let ly = padT + 6;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (const { s, i1, gain, offset } of view) {
      const ring = s.ring;
      const dec = s.decimals === undefined || s.decimals === null ? 3 : s.decimals;
      // 取“窗口内最后一个采样”，暂停时数值不会继续跳（否则看起来像还在跑）
      const k = Math.min(ring.count - 1, Math.max(0, i1 - 1));
      const last = ring.count ? ring.vAt(k) * gain + offset : NaN;
      const text = `${s.name}  ${Number.isFinite(last) ? last.toFixed(dec) : '--'}`;
      const tw = ctx.measureText(text).width + 18;
      if (lx + tw > padL + pw - 4) {
        lx = padL + 6;
        ly += 15;
      }
      ctx.fillStyle = th.legendBg;
      ctx.fillRect(lx - 3, ly - 1, tw + 3, 14);
      ctx.fillStyle = s.color || paletteColor(0);
      ctx.fillRect(lx, ly + 4, 8, 3);
      ctx.fillStyle = th.legendText;
      ctx.fillText(text, lx + 13, ly + 1);
      lx += tw + 8;
    }

    // ---------- 十字光标 ----------
    // ---------- 测点 ----------
    this._drawMarkers();

    // ---------- 十字光标 ----------
    if (this.hover && this.hover.x > padL && this.hover.x < padL + pw && this.hover.y > padT && this.hover.y < padT + ph) {
      const t = tStart + ((this.hover.x - padL) / pw) * this.win;
      ctx.save();
      ctx.strokeStyle = th.cross;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(this.hover.x, padT);
      ctx.lineTo(this.hover.x, padT + ph);
      ctx.stroke();
      ctx.restore();

      const lines = [];
      for (const { s, gain, offset } of view) {
        const ring = s.ring;
        const i = ring.indexAt(t);
        let best = -1;
        let bestDt = Infinity;
        for (let k = Math.max(0, i - 1); k <= Math.min(ring.count - 1, i); k++) {
          const dt = Math.abs(ring.tAt(k) - t);
          if (dt < bestDt) {
            bestDt = dt;
            best = k;
          }
        }
        if (best < 0) continue;
        const dec = s.decimals === undefined || s.decimals === null ? 3 : s.decimals;
        lines.push({ color: s.color, text: `${s.name}: ${(ring.vAt(best) * gain + offset).toFixed(dec)}` });
      }
      if (lines.length) {
        const bw = Math.min(230, Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 26);
        const bh = 8 + lines.length * 14;
        let bx = this.hover.x + 12;
        if (bx + bw > padL + pw) bx = this.hover.x - bw - 12;
        const by = padT + 4;
        ctx.fillStyle = th.tipBg;
        ctx.strokeStyle = th.tipBorder;
        ctx.lineWidth = 1;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx + 0.5, by + 0.5, bw, bh);
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let y = by + 5;
        for (const l of lines) {
          ctx.fillStyle = l.color || paletteColor(0);
          ctx.fillRect(bx + 6, y + 4, 6, 3);
          ctx.fillStyle = th.legendText;
          ctx.fillText(l.text, bx + 16, y);
          y += 14;
        }
      }
    }

    // 状态角标
    if (this.paused) {
      ctx.fillStyle = th.warn;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('PAUSED', padL + pw - 4, padT + ph - 4);
    }
    if (this.markers.length === 1) {
      ctx.fillStyle = th.hint;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText('再双击选第二个点（Esc 清除）', padL + pw - 4, padT + ph - (this.paused ? 18 : 4));
    } else if (!this.follow) {
      ctx.fillStyle = th.hint;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('右键 / 复位 恢复跟随', padL + 4, padT + ph - 4);
    }
  }

  /** 画 A/B 测点、连线与 Δt 标签 */
  _drawMarkers() {
    const list = this.markers;
    const plot = this._plot;
    if (!list.length || !plot) return;

    const ctx = this.ctx;
    const th = this.theme;
    const { padL, padT, pw, ph, tStart, lo, hi } = plot;
    const span = hi - lo || 1;
    const xOf = (t) => padL + ((t - tStart) / this.win) * pw;
    const yOf = (v) => padT + ph - ((v - lo) / span) * ph;

    ctx.save();
    ctx.beginPath();
    ctx.rect(padL, padT, pw, ph);
    ctx.clip();

    // 两点连线
    if (list.length === 2) {
      ctx.save();
      ctx.strokeStyle = th.legendText;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(xOf(list[0].t), yOf(list[0].v));
      ctx.lineTo(xOf(list[1].t), yOf(list[1].v));
      ctx.stroke();
      ctx.restore();
    }

    ctx.font = '11px ui-monospace, monospace';
    list.forEach((p, i) => {
      const px = xOf(p.t);
      const py = yOf(p.v);

      ctx.save();
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.4;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + ph);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(px, py, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = th.bg;
      ctx.stroke();

      const dec = p.decimals === undefined || p.decimals === null ? 3 : p.decimals;
      const text = `${i === 0 ? 'A' : 'B'} ${p.v.toFixed(dec)}`;
      const flip = px + 10 + ctx.measureText(text).width + 8 > padL + pw;
      this._tag(ctx, text, flip ? px - 8 : px + 8, py - 16, p.color, flip ? 'right' : 'left');
    });

    // Δt / Δy 标签
    const m = this.measure();
    if (m) {
      const x1 = xOf(m.a.t);
      const x2 = xOf(m.b.t);
      const y1 = yOf(m.a.v);
      const y2 = yOf(m.b.v);
      const midX = (x1 + x2) / 2;
      let midY = Math.min(y1, y2) - 30;
      if (midY < padT + 14) midY = Math.max(y1, y2) + 18;
      const lines = [`Δt ${formatDuration(m.dt)}`];
      if (m.dy !== null) {
        const dec = m.a.decimals === undefined || m.dy === null ? 3 : m.a.decimals;
        lines.push(`Δy ${m.dy >= 0 ? '+' : ''}${m.dy.toFixed(Math.min(6, dec + 1))}`);
      }
      this._tag(ctx, lines, midX, midY, th.legendText, 'center', true);
    }

    ctx.restore();
  }

  /** 画一个带底色的标签；lines 可为字符串或字符串数组；anchor='left'|'right'|'center' */
  _tag(ctx, lines, x, y, color, anchor = 'left', boxed = false) {
    const arr = Array.isArray(lines) ? lines : [lines];
    ctx.font = '11px ui-monospace, monospace';
    const th = this.theme;
    const w = Math.max(...arr.map((t) => ctx.measureText(t).width)) + (boxed ? 14 : 8);
    const h = arr.length * 14 + (boxed ? 6 : 0);
    let bx = x;
    if (anchor === 'right') bx = x - w;
    else if (anchor === 'center') bx = x - w / 2;

    if (boxed) {
      ctx.fillStyle = th.tipBg;
      ctx.strokeStyle = th.tipBorder;
      ctx.lineWidth = 1;
      ctx.fillRect(bx, y, w, h);
      ctx.strokeRect(bx + 0.5, y + 0.5, w, h);
    } else {
      ctx.fillStyle = th.legendBg;
      ctx.fillRect(bx - 2, y - 2, w + 4, h + 2);
    }

    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    arr.forEach((t, i) => {
      ctx.fillText(t, bx + (boxed ? 7 : 3), y + 3 + i * 14);
    });
  }
}

/** 8.00 ms / 1.234 s / 1m 3.2s */
export function formatDuration(sec) {
  const a = Math.abs(sec);
  if (a < 1) return (a * 1000).toFixed(a < 0.01 ? 3 : 2) + ' ms';
  if (a < 60) return a.toFixed(3) + ' s';
  const m = Math.floor(a / 60);
  return `${m}m ${(a - m * 60).toFixed(1)}s`;
}

function formatTick(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(1);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
