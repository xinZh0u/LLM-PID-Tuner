import { crc16 } from './crc16.js';

/* 与 llm_tuner.h 一一对应 */
export const TYPE = {
  INT8: 0,
  INT16: 1,
  INT32: 2,
  UINT8: 3,
  UINT16: 4,
  UINT32: 5,
  FLOAT: 6,
  DOUBLE: 7,
};

export const TYPE_META = [
  { key: 'int8', label: 'int8', bytes: 1, integer: true, signed: true, decimals: 0 },
  { key: 'int16', label: 'int16', bytes: 2, integer: true, signed: true, decimals: 0 },
  { key: 'int32', label: 'int32', bytes: 4, integer: true, signed: true, decimals: 0 },
  { key: 'uint8', label: 'uint8', bytes: 1, integer: true, signed: false, decimals: 0 },
  { key: 'uint16', label: 'uint16', bytes: 2, integer: true, signed: false, decimals: 0 },
  { key: 'uint32', label: 'uint32', bytes: 4, integer: true, signed: false, decimals: 0 },
  { key: 'float', label: 'float', bytes: 4, integer: false, signed: true, decimals: 4 },
  { key: 'double', label: 'double', bytes: 8, integer: false, signed: true, decimals: 4 },
];

export const ATTR_READ = 1;
export const ATTR_WRITE = 2;
export const ATTR_TRANS = 4;

export const PAK = {
  DESC: 0,
  ARG: 1,
  TUNNING: 2,
  TRANS_SET: 3,
};

/** 一帧 = header(5) + payload(len) + crc16(2)，小端 */
export const FRAME_HEADER_SIZE = 5;
export const FRAME_TAIL_SIZE = 2;

const HEAD0 = 0x54; // 0x4C54 低字节 'T'
const HEAD1 = 0x4c; // 高字节 'L'
const MAX_PAYLOAD = 8192;

const textDecoder = new TextDecoder('utf-8');
const dv = new DataView(new ArrayBuffer(8));

/** 4 字节小端 → u32 */
export function readU32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

/** 下位机扩展出来的 u32 → 实际数值（只取低 size 字节，double 用 float 精度还原） */
export function u32ToValue(type, u) {
  switch (type) {
    case TYPE.INT8:
      return (u << 24) >> 24;
    case TYPE.INT16:
      return (u << 16) >> 16;
    case TYPE.INT32:
      return u | 0;
    case TYPE.UINT8:
      return u & 0xff;
    case TYPE.UINT16:
      return u & 0xffff;
    case TYPE.UINT32:
      return u >>> 0;
    case TYPE.FLOAT:
    case TYPE.DOUBLE:
      dv.setUint32(0, u, true);
      return dv.getFloat32(0, true);
    default:
      return NaN;
  }
}

/** 数值 → 下位机期望的 u32（整数直接截断，浮点取 IEEE754 位模式） */
export function valueToU32(type, v) {
  switch (type) {
    case TYPE.FLOAT:
    case TYPE.DOUBLE:
      dv.setFloat32(0, Number(v), true);
      return dv.getUint32(0, true);
    default:
      return Math.trunc(Number(v) || 0) >>> 0;
  }
}

/** 组装一帧（含 CRC16） */
export function encodeFrame(id, payload) {
  const total = FRAME_HEADER_SIZE + payload.length + FRAME_TAIL_SIZE;
  const buf = new Uint8Array(total);
  buf[0] = HEAD0;
  buf[1] = HEAD1;
  buf[2] = payload.length & 0xff;
  buf[3] = (payload.length >> 8) & 0xff;
  buf[4] = id & 0xff;
  buf.set(payload, FRAME_HEADER_SIZE);
  const crc = crc16(buf, total - FRAME_TAIL_SIZE, 0);
  buf[total - 2] = crc & 0xff;
  buf[total - 1] = (crc >> 8) & 0xff;
  return buf;
}

/** 调参包负载: index + u32 */
export function encodeTunning(index, u32) {
  const p = new Uint8Array(5);
  p[0] = index & 0xff;
  p[1] = u32 & 0xff;
  p[2] = (u32 >>> 8) & 0xff;
  p[3] = (u32 >>> 16) & 0xff;
  p[4] = (u32 >>> 24) & 0xff;
  return p;
}

/** 传输设置包负载: arg_num + 位图(高位在前) */
export function encodeTransSet(flags) {
  const n = flags.length;
  const bytes = (n + 7) >> 3;
  const p = new Uint8Array(1 + bytes);
  p[0] = n & 0xff;
  for (let i = 0; i < n; i++) {
    if (flags[i]) p[1 + (i >> 3)] |= 1 << (7 - (i & 7));
  }
  return p;
}

/**
 * 解析描述包负载: [type<<4|attr] name ':' desc '\0' 重复
 * 单条描述不会被拆包（下位机保证），若最后一截不完整则丢弃。
 */
export function parseDescPayload(payload) {
  const out = [];
  let i = 0;
  while (i < payload.length) {
    const head = payload[i];
    let nul = -1;
    for (let k = i + 1; k < payload.length; k++) {
      if (payload[k] === 0) {
        nul = k;
        break;
      }
    }
    if (nul < 0) break;
    if (head === 0) {
      i = nul + 1;
      continue;
    }
    let colon = -1;
    for (let k = i + 1; k < nul; k++) {
      if (payload[k] === 0x3a) {
        colon = k;
        break;
      }
    }
    const type = (head >> 4) & 0x0f;
    const attr = head & 0x0f;
    const nameEnd = colon < 0 ? nul : colon;
    const name = textDecoder.decode(payload.subarray(i + 1, nameEnd));
    const desc = colon < 0 ? '' : textDecoder.decode(payload.subarray(colon + 1, nul));
    out.push({ type, attr, name, desc });
    i = nul + 1;
  }
  return out;
}

/**
 * 流式帧解析器。缓冲区只保留未消费的数据。
 */
export class TunerParser {
  constructor(onPacket) {
    this.onPacket = onPacket;
    this.buf = new Uint8Array(4096);
    this.len = 0;
    this.bytes = 0;
    this.frames = 0;
    this.crcErrors = 0;
    this.dropped = 0;
  }

  reset() {
    this.len = 0;
    this.bytes = 0;
    this.frames = 0;
    this.crcErrors = 0;
    this.dropped = 0;
  }

  push(chunk) {
    this._append(chunk);
    this._parse();
  }

  _append(chunk) {
    const need = this.len + chunk.length;
    if (need > this.buf.length) {
      let cap = this.buf.length;
      while (cap < need) cap <<= 1;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    this.buf.set(chunk, this.len);
    this.len = need;
    this.bytes += chunk.length;
  }

  _consume(n) {
    if (n <= 0) return;
    if (n >= this.len) {
      this.len = 0;
      return;
    }
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
  }

  _parse() {
    const b = this.buf;
    let off = 0;
    while (this.len - off >= FRAME_HEADER_SIZE + FRAME_TAIL_SIZE) {
      if (b[off] !== HEAD0 || b[off + 1] !== HEAD1) {
        off++;
        this.dropped++;
        continue;
      }
      const plen = b[off + 2] | (b[off + 3] << 8);
      if (plen > MAX_PAYLOAD) {
        off++;
        this.dropped++;
        continue;
      }
      const total = FRAME_HEADER_SIZE + plen + FRAME_TAIL_SIZE;
      if (this.len - off < total) break;

      const crc = crc16(b, total - FRAME_TAIL_SIZE, off);
      if ((crc & 0xff) !== b[off + total - 2] || (crc >> 8) !== b[off + total - 1]) {
        this.crcErrors++;
        off++;
        continue;
      }

      const id = b[off + 4];
      const payload = b.subarray(off + FRAME_HEADER_SIZE, off + FRAME_HEADER_SIZE + plen);
      this.frames++;
      try {
        this.onPacket(id, payload);
      } catch (e) {
        console.error('[tuner] packet handler', e);
      }
      off += total;
    }
    this._consume(off);
  }
}
