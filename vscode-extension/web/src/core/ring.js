/**
 * 定长环形缓冲，用于保存单个参数的 (时间, 数值) 采样。
 * 时间单调递增，支持二分查找定位窗口起点。
 */
export class Ring {
  constructor(cap = 50000) {
    this.cap = Math.max(16, cap | 0);
    this.t = new Float64Array(this.cap);
    this.v = new Float64Array(this.cap);
    this.head = 0; // 下一个写入位置
    this.count = 0;
    this.total = 0;
  }

  clear() {
    this.head = 0;
    this.count = 0;
    this.total = 0;
  }

  resize(cap) {
    const c = Math.max(16, cap | 0);
    if (c === this.cap) return;
    const oldT = this.t;
    const oldV = this.v;
    const oldCap = this.cap;
    const oldCount = this.count;
    const oldHead = this.head;
    this.cap = c;
    this.t = new Float64Array(c);
    this.v = new Float64Array(c);
    this.head = 0;
    this.count = 0;
    const start = Math.max(0, oldCount - c);
    for (let k = start; k < oldCount; k++) {
      const idx = ((oldHead - oldCount + k) % oldCap + oldCap) % oldCap;
      this.push(oldT[idx], oldV[idx]);
    }
  }

  push(t, v) {
    this.t[this.head] = t;
    this.v[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    this.total++;
  }

  tAt(k) {
    return this.t[(this.head - this.count + k + this.cap * 2) % this.cap];
  }

  vAt(k) {
    return this.v[(this.head - this.count + k + this.cap * 2) % this.cap];
  }

  last() {
    return this.count ? this.vAt(this.count - 1) : NaN;
  }

  lastT() {
    return this.count ? this.tAt(this.count - 1) : NaN;
  }

  /** 第一个 t >= time 的下标（可能等于 count） */
  indexAt(time) {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tAt(mid) < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
