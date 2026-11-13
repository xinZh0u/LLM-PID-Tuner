import { Emitter } from './emitter.js';
import { Ring } from './ring.js';
import {
  TunerParser,
  parseDescPayload,
  readU32,
  u32ToValue,
  valueToU32,
  encodeFrame,
  encodeTunning,
  encodeTransSet,
  PAK,
  ATTR_WRITE,
  ATTR_TRANS,
  ATTR_READ,
  TYPE_META,
} from './tuner.js';

export class Param {
  constructor(index, cap) {
    this.index = index;
    this.type = null;
    this.attr = 0;
    this.name = '';
    this.desc = '';
    this.hasDesc = false;
    this.ring = new Ring(cap);
    this.updates = 0;
  }

  get kind() {
    return this.type === null ? 'unknown' : TYPE_META[this.type].key;
  }

  get writable() {
    return (this.attr & ATTR_WRITE) !== 0;
  }

  get readable() {
    return (this.attr & ATTR_READ) !== 0;
  }

  get transitive() {
    return (this.attr & ATTR_TRANS) !== 0;
  }
}

/**
 * 所有分页共享的数据中枢：一份串口字节流 → 一份解析结果 → 各分页各自显示。
 */
export class Hub extends Emitter {
  constructor() {
    super();
    this.cap = 50000;
    this.params = [];
    this.parser = new TunerParser((id, payload) => this._onPacket(id, payload));
    this.stats = {
      rx: 0,
      tx: 0,
      frames: 0,
      frameRate: 0,
      rate: 0,
      crcErrors: 0,
      dropped: 0,
      descPackets: 0,
      argPackets: 0,
      desync: false,
    };
    this._lastStat = { t: performance.now(), rx: 0, frames: 0, framesWindow: 0 };
    this._descIndex = 0;
    this._stamp = null;
    this.attached = null;
  }

  /** 采样时间原点（秒） */
  now() {
    return performance.now() / 1000;
  }

  attach(link) {
    this.detach();
    this.attached = link.on('data', (u8) => this._onData(u8));
  }

  detach() {
    if (this.attached) this.attached();
    this.attached = null;
  }

  reset() {
    this.params = [];
    this._descIndex = 0;
    this.parser.reset();
    this.stats.rx = 0;
    this.stats.tx = 0;
    this.stats.frames = 0;
    this.stats.crcErrors = 0;
    this.stats.dropped = 0;
    this.stats.descPackets = 0;
    this.stats.argPackets = 0;
    this.stats.desync = false;
    this.emit('params');
  }

  clearData() {
    for (const p of this.params) p.ring.clear();
    this.emit('cleared');
  }

  setCap(cap) {
    this.cap = cap;
    for (const p of this.params) p.ring.resize(cap);
  }

  ensureParam(index) {
    while (this.params.length <= index) {
      this.params.push(new Param(this.params.length, this.cap));
    }
    return this.params[index];
  }

  _onData(u8, t) {
    this.stats.rx += u8.length;
    this._stamp = typeof t === 'number' ? t : null;
    this.parser.push(u8);
    this._stamp = null;
    this.stats.frames = this.parser.frames;
    this.stats.crcErrors = this.parser.crcErrors;
    this.stats.dropped = this.parser.dropped;
    this.emit('rx', u8);
  }

  _onPacket(id, payload) {
    if (id === PAK.DESC) {
      this.stats.descPackets++;
      const entries = parseDescPayload(payload);
      let changed = false;
      for (const e of entries) {
        const p = this.ensureParam(this._descIndex++);
        p.type = e.type;
        p.attr = e.attr;
        p.name = e.name;
        p.desc = e.desc;
        p.hasDesc = true;
        changed = true;
      }
      if (changed) this.emit('params', { reason: 'desc' });
      return;
    }
    if (id === PAK.ARG) {
      this.stats.argPackets++;
      this._decodeArgs(payload);
      return;
    }
  }

  _decodeArgs(payload) {
    if (payload.length < 1) return;
    const argNum = payload[0];
    const bitmapBytes = (argNum + 7) >> 3;
    if (payload.length < 1 + bitmapBytes) return;

    if (argNum !== this.params.length) {
      this.stats.desync = true;
      this.ensureParam(argNum - 1);
      this.emit('params', { reason: 'desync' });
    }

    const t = this._stamp === null ? this.now() : this._stamp;
    let off = 1 + bitmapBytes;
    let changed = false;
    let stamp = t;
    for (let i = 0; i < argNum; i++) {
      const on = (payload[1 + (i >> 3)] >> (7 - (i & 7))) & 1;
      if (!on) continue;
      if (off + 4 > payload.length) break;
      const p = this.params[i];
      if (p && p.type !== null) {
        // 保证时间戳严格递增，二分查找才可靠
        const lastT = p.ring.lastT();
        if (Number.isFinite(lastT) && stamp <= lastT) stamp = lastT + 1e-6;
        p.ring.push(stamp, u32ToValue(p.type, readU32(payload, off)));
        p.updates++;
        changed = true;
      }
      off += 4;
    }
    if (changed) this.emit('samples');
  }

  /** 每次重新连接/重置时清空描述计数 */
  beginSession() {
    this._descIndex = 0;
  }

  sendTuning(index, value) {
    const p = this.params[index];
    if (!p || p.type === null) return false;
    this.sendFrame(PAK.TUNNING, encodeTunning(index, valueToU32(p.type, value)));
    return true;
  }

  sendTransSet(flags) {
    this.sendFrame(PAK.TRANS_SET, encodeTransSet(flags));
  }

  sendFrame(id, payload) {
    const frame = encodeFrame(id, payload);
    this.emit('send', frame);
    return frame;
  }

  tickStats() {
    const now = performance.now();
    const dt = (now - this._lastStat.t) / 1000;
    if (dt >= 0.5) {
      this.stats.rate = Math.round((this.stats.rx - this._lastStat.rx) / dt);
      this.stats.frameRate = Math.round((this.parser.frames - this._lastStat.frames) / dt);
      this._lastStat.t = now;
      this._lastStat.rx = this.stats.rx;
      this._lastStat.frames = this.parser.frames;
      this.emit('stats');
    }
  }
}
