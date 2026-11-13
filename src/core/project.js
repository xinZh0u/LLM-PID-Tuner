import { buildCodeMap, planEdits, applyEdits, diffPreview } from './srcmap.js';

const SRC_EXT = new Set(['.c', '.h', '.cpp', '.hpp', '.cc', '.hh']);
// STM32 工程里这些目录基本是库代码，跳过可显著加快扫描
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.settings', 'build', 'Build', 'Debug', 'Release',
  'out', 'Drivers', 'Middlewares', 'CMSIS', 'HAL_Driver', 'obj', 'bin',
]);

const MAX_FILES = 600;
const MAX_FILE_BYTES = 1024 * 1024;

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* 后端：浏览器目录授权（File System Access API）                        */
/* ------------------------------------------------------------------ */

const IDB_NAME = 'llmtuner';
const IDB_STORE = 'handles';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class FsDirBackend {
  constructor(handle) {
    this.kind = 'fs';
    this.handle = handle;
    this.name = handle.name;
  }

  static get supported() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
  }

  static async pick() {
    const handle = await window.showDirectoryPicker({ id: 'llmtuner-project', mode: 'readwrite' });
    await idbSet('projectDir', handle);
    return new FsDirBackend(handle);
  }

  static async restore() {
    try {
      const handle = await idbGet('projectDir');
      if (!handle) return null;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      return { backend: new FsDirBackend(handle), granted: perm === 'granted' };
    } catch (_) {
      return null;
    }
  }

  async requestPermission() {
    const perm = await this.handle.requestPermission({ mode: 'readwrite' });
    return perm === 'granted';
  }

  async _fileHandle(rel, create = false) {
    const parts = rel.split('/').filter(Boolean);
    let dir = this.handle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create });
    }
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async listSourceFiles() {
    const out = [];
    const walk = async (dir, prefix, depth) => {
      if (out.length >= MAX_FILES || depth > 6) return;
      for await (const [name, h] of dir.entries()) {
        if (out.length >= MAX_FILES) return;
        if (h.kind === 'directory') {
          if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
          await walk(h, prefix + name + '/', depth + 1);
        } else if (SRC_EXT.has(extOf(name))) {
          out.push(prefix + name);
        }
      }
    };
    await walk(this.handle, '', 0);
    return out;
  }

  async readFile(rel) {
    const fh = await this._fileHandle(rel);
    const file = await fh.getFile();
    if (file.size > MAX_FILE_BYTES) return null;
    return file.text();
  }

  async writeFile(rel, text) {
    const fh = await this._fileHandle(rel, true);
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
}

/* ------------------------------------------------------------------ */
/* 后端：VS Code 扩展桥接                                             */
/* ------------------------------------------------------------------ */

export class BridgeBackend {
  constructor(base, token) {
    this.kind = 'bridge';
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.name = 'VS Code 工作区';
  }

  async _post(path, body) {
    const res = await fetch(this.base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`桥接返回 HTTP ${res.status}`);
    return res.json();
  }

  async ping() {
    const res = await fetch(this.base + '/ping', {
      headers: this.token ? { Authorization: 'Bearer ' + this.token } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    this.name = json.root ? json.root.split(/[\\/]/).pop() : 'VS Code 工作区';
    return json;
  }

  async listSourceFiles() {
    const r = await this._post('/fs/list', {});
    return r.files;
  }

  async readFile(rel) {
    const r = await this._post('/fs/read', { path: rel });
    return r.text;
  }

  async writeFile(rel, text) {
    await this._post('/fs/write', { path: rel, text });
  }
}

/* ------------------------------------------------------------------ */
/* 工程状态                                                           */
/* ------------------------------------------------------------------ */

export class Project {
  constructor(hub) {
    this.hub = hub;
    this.backend = null;
    this.files = [];
    this.map = null;
    this.errors = [];
    this.scannedAt = 0;
  }

  get ready() {
    return !!this.backend && this.files.length > 0;
  }

  async setBackend(backend) {
    this.backend = backend;
    this.files = [];
    this.map = null;
    this.errors = [];
  }

  async scan() {
    if (!this.backend) throw new Error('还没有选择工程目录');
    this.errors = [];
    const paths = await this.backend.listSourceFiles();
    const files = [];
    for (const p of paths) {
      try {
        const text = await this.backend.readFile(p);
        if (typeof text === 'string') files.push({ path: p, text });
      } catch (e) {
        this.errors.push(`${p}: ${e.message || e}`);
      }
    }
    this.files = files;
    this.map = buildCodeMap(files);
    this.scannedAt = Date.now();
    return { files: files.length, params: this.map.calls.length };
  }

  /** 参数名 → 当前在线值 */
  liveValue(name) {
    const p = this.hub.params.find((x) => x.name === name);
    if (!p) return null;
    const v = p.ring.last();
    return Number.isFinite(v) ? v : null;
  }

  /** 生成表格行 */
  rows() {
    if (!this.map) return [];
    return this.map.entries.map(({ call, init }) => ({
      name: call.name,
      desc: call.desc,
      type: call.type,
      writable: (call.attr & 2) !== 0,
      target: call.target || call.rawTarget,
      file: init ? init.file : call.file,
      line: init ? init.line : call.line,
      hasInit: !!init,
      codeText: init ? init.text : '',
      codeValue: init ? init.value : null,
      live: this.liveValue(call.name),
    }));
  }

  plan(assignments) {
    if (!this.files.length) return { edits: [], missing: [] };
    return planEdits(this.files, assignments);
  }

  preview(assignments) {
    const plan = this.plan(assignments);
    return { ...plan, text: diffPreview(plan.edits) };
  }

  async apply(assignments) {
    const plan = this.plan(assignments);
    if (!plan.edits.length) return { written: [], skipped: plan.missing };
    const changed = applyEdits(this.files, plan.edits);
    for (const f of changed) {
      await this.backend.writeFile(f.path, f.text);
      const local = this.files.find((x) => x.path === f.path);
      if (local) local.text = f.text;
    }
    this.map = buildCodeMap(this.files);
    return { written: changed.map((c) => c.path), edits: plan.edits, skipped: plan.missing };
  }
}
