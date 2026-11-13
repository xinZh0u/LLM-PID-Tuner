import { Emitter } from './emitter.js';
import { TunerParser, encodeFrame, readU32, u32ToValue, PAK, TYPE, TYPE_META } from './tuner.js';

/** Web Serial 串口链路 */
export class WebSerialLink extends Emitter {
  constructor(port, opts) {
    super();
    this.port = port;
    this.opts = opts;
    this.reader = null;
    this.writer = null;
    this.closed = false;
    this.label = '串口';
    this._writeQueue = Promise.resolve();
  }

  async open() {
    await this.port.open({
      baudRate: this.opts.baudRate,
      dataBits: this.opts.dataBits,
      stopBits: this.opts.stopBits,
      parity: this.opts.parity,
      flowControl: this.opts.flowControl,
      bufferSize: this.opts.bufferSize,
    });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.closed = false;
    this._readLoop();
    this.emit('open');
  }

  async _readLoop() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          // 复制一份，读缓冲会被复用
          this.emit('data', value.slice());
        }
      }
    } catch (e) {
      if (!this.closed) this.emit('error', e);
    } finally {
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    }
  }

  write(bytes) {
    if (!this.writer) return;
    const w = this.writer;
    this._writeQueue = this._writeQueue
      .then(() => w.write(bytes))
      .catch((e) => this.emit('error', e));
  }

  async setSignals(signals) {
    try {
      await this.port.setSignals(signals);
    } catch (e) {
      this.emit('error', e);
    }
  }

  async close() {
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch (_) {}
    try {
      this.reader?.releaseLock();
    } catch (_) {}
    try {
      await this.writer?.close();
    } catch (_) {}
    try {
      this.writer?.releaseLock();
    } catch (_) {}
    try {
      await this.port.close();
    } catch (_) {}
    this.emit('close');
  }
}

/* ------------------------------------------------------------------ */
/* 模拟数据源：用与下位机完全一致的帧格式产生数据，便于无硬件时验证 UI */
/* ------------------------------------------------------------------ */

const MOCK_PARAMS = [
  { type: TYPE.FLOAT, attr: 1 | 2 | 4, name: 'target', desc: '目标速度 (rad/s)' },
  { type: TYPE.FLOAT, attr: 1 | 2 | 4, name: 'speed', desc: '实际速度 (rad/s)' },
  { type: TYPE.FLOAT, attr: 1 | 2 | 4, name: 'current', desc: 'q 轴电流 (A)' },
  { type: TYPE.FLOAT, attr: 1 | 2 | 4, name: 'kp', desc: '速度环 Kp' },
  { type: TYPE.FLOAT, attr: 1 | 2 | 4, name: 'ki', desc: '速度环 Ki' },
  { type: TYPE.FLOAT, attr: 1 | 2 | 4, name: 'kd', desc: '速度环 Kd' },
  { type: TYPE.UINT16, attr: 1 | 4, name: 'tick', desc: '循环计数' },
  { type: TYPE.INT16, attr: 1 | 4, name: 'error', desc: '跟随误差 ×1000' },
];

export class MockLink extends Emitter {
  constructor() {
    super();
    this.opened = false;
    this.label = '模拟数据源';
    this.params = MOCK_PARAMS.map((p) => ({ ...p, v: p.name === 'kp' ? 1.2 : p.name === 'ki' ? 0.05 : 0 }));
    this.trans = this.params.map(() => true);
    this.timer = null;
    this.t0 = performance.now();
    this.samples = 0;
    this.parser = new TunerParser((id, payload) => this._onPacket(id, payload));
  }

  async open() {
    this.opened = true;
    this.t0 = performance.now();
    this.simT = 0;
    this.samples = 0;
    this.emit('open');
    this._sendDesc();
    this.timer = setInterval(() => this._tick(), 10);
  }

  _sendDesc() {
    const enc = new TextEncoder();
    const bytes = [];
    for (const p of this.params) {
      bytes.push(((p.type & 0x0f) << 4) | (p.attr & 0x0f));
      bytes.push(...enc.encode(p.name + ':' + p.desc));
      bytes.push(0);
    }
    this.emit('data', encodeFrame(PAK.DESC, new Uint8Array(bytes)));
  }

  /** 后台标签页定时器会被节流，这里按真实经过时间补齐丢失的采样（固定 10ms 步长） */
  _tick() {
    if (!this.opened) return;
    const real = (performance.now() - this.t0) / 1000;
    let steps = Math.round((real - this.simT) / 0.01);
    if (steps < 1) steps = 1;
    if (steps > 300) {
      // 落后太多就只补最近 3 秒，保证时间戳仍然是等间隔的
      this.simT = real - 3;
      steps = 300;
    }
    for (let i = 0; i < steps; i++) {
      this.simT += 0.01;
      this._emitFrame(this.simT);
    }
  }

  _emitFrame(t) {
    const target = Math.sin(t * 0.8) * 2.2;
    const kp = this.params[3].v;
    const follow = 0.92 - Math.min(0.35, Math.abs(kp - 1.2) * 0.15);
    const speed = target * follow + Math.sin(t * 31) * 0.035 + (Math.random() - 0.5) * 0.01;
    const current = Math.sin(t * 3.1) * 0.8 + (speed - target) * 0.5;
    const values = [
      target,
      speed,
      current,
      kp,
      this.params[4].v,
      this.params[5].v,
      this.samples & 0xffff,
      Math.round((target - speed) * 1000),
    ];

    const n = this.params.length;
    const bitmapBytes = (n + 7) >> 3;
    const selected = [];
    const bitmap = new Uint8Array(bitmapBytes);
    for (let i = 0; i < n; i++) {
      if (this.trans[i]) {
        bitmap[i >> 3] |= 1 << (7 - (i & 7));
        selected.push(i);
      }
    }
    const payload = new Uint8Array(1 + bitmapBytes + selected.length * 4);
    payload[0] = n;
    payload.set(bitmap, 1);
    let off = 1 + bitmapBytes;
    const dv = new DataView(new ArrayBuffer(4));
    for (const i of selected) {
      const meta = TYPE_META[this.params[i].type];
      let u;
      if (meta.integer) u = Math.trunc(values[i]) >>> 0;
      else {
        dv.setFloat32(0, values[i], true);
        u = dv.getUint32(0, true);
      }
      payload[off] = u & 0xff;
      payload[off + 1] = (u >>> 8) & 0xff;
      payload[off + 2] = (u >>> 16) & 0xff;
      payload[off + 3] = (u >>> 24) & 0xff;
      off += 4;
    }
    this.samples++;
    this.emit('data', encodeFrame(PAK.ARG, payload), this.t0 / 1000 + t);
  }

  _onPacket(id, payload) {
    if (id === PAK.TUNNING) {
      if (payload.length < 5) return;
      const i = payload[0];
      const p = this.params[i];
      if (!p) return;
      p.v = u32ToValue(p.type, readU32(payload, 1));
    } else if (id === PAK.TRANS_SET) {
      if (payload.length < 1) return;
      const n = payload[0];
      const bytes = (n + 7) >> 3;
      if (payload.length < 1 + bytes) return;
      for (let i = 0; i < n; i++) {
        if (i >= this.trans.length) break;
        this.trans[i] = ((payload[1 + (i >> 3)] >> (7 - (i & 7))) & 1) === 1;
      }
      for (let i = n; i < this.trans.length; i++) this.trans[i] = false;
    }
  }

  write(bytes) {
    this.parser.push(bytes);
  }

  async setSignals() {}

  async close() {
    this.opened = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('close');
  }
}
