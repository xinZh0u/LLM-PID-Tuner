import { Emitter } from './emitter.js';
import { WebSerialLink, MockLink } from './link.js';

/**
 * 全局唯一的串口连接（所有分页共享同一条数据流）。
 */
export class Conn extends Emitter {
  constructor(hub) {
    super();
    this.hub = hub;
    this.supported = typeof navigator !== 'undefined' && 'serial' in navigator;
    this.ports = [];
    this.portKey = 'mock';
    this.opts = {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 1 << 20,
    };
    this.signals = { dataTerminalReady: true, requestToSend: true };
    this.link = null;
    this.status = 'idle'; // idle | connecting | open | error
    this.error = '';

    hub.on('send', (frame) => this.write(frame));

    if (this.supported) {
      navigator.serial.addEventListener('connect', () => this.refreshPorts());
      navigator.serial.addEventListener('disconnect', () => this.refreshPorts());
      this.refreshPorts();
    }
  }

  get connected() {
    return this.status === 'open';
  }

  async refreshPorts() {
    if (!this.supported) return;
    try {
      this.ports = await navigator.serial.getPorts();
    } catch (e) {
      this.ports = [];
    }
    this.emit('ports');
  }

  portLabel(port, i) {
    try {
      const info = port.getInfo ? port.getInfo() : {};
      const id = [info.usbVendorId, info.usbProductId]
        .filter((v) => v !== undefined)
        .map((v) => '0x' + v.toString(16).padStart(4, '0'))
        .join(':');
      return `端口 ${i + 1}${id ? ' · ' + id : ''}`;
    } catch (_) {
      return `端口 ${i + 1}`;
    }
  }

  /** 触发浏览器授权选择新端口 */
  async requestPort() {
    if (!this.supported) throw new Error('浏览器不支持 Web Serial');
    const port = await navigator.serial.requestPort();
    await this.refreshPorts();
    const idx = this.ports.indexOf(port);
    this.portKey = idx >= 0 ? 'p' + idx : 'mock';
    this.emit('ports');
    return this.portKey;
  }

  async connect() {
    if (this.status === 'open' || this.status === 'connecting') return;
    this.status = 'connecting';
    this.error = '';
    this.emit('state');

    try {
      let link;
      if (this.portKey === 'mock') {
        link = new MockLink();
      } else {
        const idx = Number(this.portKey.slice(1));
        const port = this.ports[idx];
        if (!port) throw new Error('端口不存在，请重新选择');
        link = new WebSerialLink(port, { ...this.opts });
      }

      this.hub.reset();
      this.hub.beginSession();
      this.hub.attach(link);
      link.on('close', () => {
        if (this.link === link) this._onClosed();
      });
      link.on('error', (e) => {
        this.error = String(e && e.message ? e.message : e);
        this.emit('state');
      });

      await link.open();
      this.link = link;
      this.status = 'open';
      this.emit('state');
      if (link instanceof WebSerialLink) {
        link.setSignals(this.signals);
      }
    } catch (e) {
      this.status = 'error';
      this.error = String(e && e.message ? e.message : e);
      this.hub.detach();
      this.emit('state');
    }
  }

  _onClosed() {
    this.hub.detach();
    this.link = null;
    this.status = 'idle';
    this.emit('state');
  }

  async disconnect() {
    const link = this.link;
    this.link = null;
    if (link) await link.close();
    this.hub.detach();
    if (this.status !== 'error') this.status = 'idle';
    this.emit('state');
  }

  write(bytes) {
    this.hub.stats.tx += bytes.length;
    if (this.link) this.link.write(bytes);
    this.emit('tx', bytes, false);
  }

  setSignals(partial) {
    Object.assign(this.signals, partial);
    if (this.link && this.link instanceof WebSerialLink) this.link.setSignals(this.signals);
    this.emit('state');
  }

  setOpts(partial) {
    Object.assign(this.opts, partial);
    this.emit('state');
  }
}
