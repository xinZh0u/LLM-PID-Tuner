const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * 串口输入输出界面：文本 / Hex 两种显示模式，按块累积到单个文本节点，避免海量 DOM 节点。
 */
export class Console {
  constructor(host) {
    this.host = host;
    this.el = document.createElement('div');
    this.el.className = 'console-lines';
    host.appendChild(this.el);
    this.mode = 'text';
    this.paused = false;
    this.buf = '';
    this.cap = 400000;
    this.decoder = new TextDecoder('utf-8');
    this.stdoutDirty = false;
    this.autoscroll = true;
  }

  setMode(mode) {
    this.mode = mode === 'hex' ? 'hex' : 'text';
    this.decoder = new TextDecoder('utf-8');
  }

  setPaused(paused) {
    this.paused = paused;
  }

  clear() {
    this.buf = '';
    this.el.textContent = '';
    this.decoder = new TextDecoder('utf-8');
  }

  pushRx(u8) {
    if (this.paused) return;
    this._append(u8, false);
  }

  pushTx(u8) {
    this._append(u8, true);
  }

  _append(u8, isTx) {
    let text;
    if (this.mode === 'hex') {
      const parts = new Array(u8.length);
      for (let i = 0; i < u8.length; i++) parts[i] = HEX[u8[i]];
      text = parts.join(' ') + ' ';
    } else if (isTx) {
      text = this.decoder.decode(u8);
    } else {
      text = this.decoder.decode(u8, { stream: true });
    }

    if (isTx) text = '\n→ ' + text.replace(/\r?\n$/, '');
    this.buf += text;

    if (this.buf.length > this.cap) {
      this.buf = this.buf.slice(this.buf.length - this.cap * 0.6);
      this.el.textContent = this.buf;
    }
    this.stdoutDirty = true;
  }

  flush() {
    if (!this.stdoutDirty) return;
    this.stdoutDirty = false;
    this.el.textContent = this.buf;
    if (this.autoscroll) {
      const h = this.host;
      h.scrollTop = h.scrollHeight;
    }
  }
}
