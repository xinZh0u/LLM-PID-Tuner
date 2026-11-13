/** 极简事件总线 */
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(ev, fn) {
    let set = this._handlers.get(ev);
    if (!set) {
      set = new Set();
      this._handlers.set(ev, set);
    }
    set.add(fn);
    return () => this.off(ev, fn);
  }

  off(ev, fn) {
    const set = this._handlers.get(ev);
    if (set) set.delete(fn);
  }

  emit(ev, ...args) {
    const set = this._handlers.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[emit]', ev, e);
      }
    }
  }
}
