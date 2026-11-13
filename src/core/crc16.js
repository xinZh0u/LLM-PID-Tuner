/* CRC16 与下位机 crc.c 一致: 反射多项式 0x8408, 初值 0xFFFF, 无最终异或 (CRC-16/MCRF4XX) */

const TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} len   参与计算的字节数
 * @param {number} start 起始偏移
 * @param {number} crc   初值
 */
export function crc16(bytes, len, start = 0, crc = 0xffff) {
  let c = crc;
  const end = start + len;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ TABLE[(c ^ bytes[i]) & 0xff];
  return c & 0xffff;
}
