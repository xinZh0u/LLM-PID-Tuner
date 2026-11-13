// 用 stub 的 vscode 模块跑一遍扩展：验证 HTTP 服务、令牌、静态资源注入与源码读写接口。
//   $env:ELECTRON_RUN_AS_NODE=1 ; & Code.exe scripts/test-extension.js
const Module = require('module');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const reportFile = path.join(root, 'test-report.txt');
fs.writeFileSync(reportFile, '');
const out = (...a) => fs.appendFileSync(reportFile, a.join(' ') + '\n');
const console = { log: out, error: out };

const wsRoot = path.join(os.tmpdir(), 'llmtuner-test-ws');
fs.rmSync(wsRoot, { recursive: true, force: true });
fs.mkdirSync(wsRoot, { recursive: true });
fs.writeFileSync(
  path.join(wsRoot, 'motor.c'),
  '#include "llm_tuner.h"\n\nstatic float speed_pid_kp = 1.2f;\n\nvoid init(void)\n{\n    tuner_add_arg(TUNER_ARG_TYPE_FLOAT, TUNER_ARG_ATTR_READ | TUNER_ARG_ATTR_WRITE, "kp", "速度环 Kp", &speed_pid_kp);\n}\n'
);
fs.writeFileSync(path.join(wsRoot, 'note.txt'), 'ignored');

const PORT = 5199;
const settings = { port: PORT, autoStart: true, autoOpen: false, maxFiles: 100, webRoot: '' };
const commands = new Map();

const disposable = { dispose() {} };
const vscodeStub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {}, text: '', tooltip: '' }),
    registerWebviewViewProvider: () => disposable,
    showInformationMessage: async () => undefined,
    showWarningMessage: () => {},
    showErrorMessage: () => {},
    activeColorTheme: { kind: 2 },
  },
  commands: {
    registerCommand: (id, fn) => {
      commands.set(id, fn);
      return disposable;
    },
    executeCommand: async (id) => {
      const fn = commands.get(id);
      if (fn) return fn();
      return undefined;
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: wsRoot } }],
    textDocuments: [],
    getConfiguration: () => ({ get: (k) => settings[k] }),
    applyEdit: async () => true,
  },
  env: {
    clipboard: { writeText: async () => {} },
    openExternal: async () => true,
  },
  Uri: { parse: (s) => ({ toString: () => s }) },
  Range: class {},
  WorkspaceEdit: class {
    replace() {}
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const ext = require(path.join(process.env.EXT_DIR || path.join(root, 'vscode-extension'), 'extension.js'));

const context = {
  extensionPath: process.env.EXT_DIR || path.join(root, 'vscode-extension'),
  subscriptions: [],
  globalState: {
    _v: {},
    get(k) {
      return this._v[k];
    },
    update(k, v) {
      this._v[k] = v;
      return Promise.resolve();
    },
  },
};

function request(method, urlPath, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: urlPath,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

(async () => {
  ext.activate(context);
  await new Promise((r) => setTimeout(r, 500));
  const token = context.globalState.get('llmTuner.token');
  console.log(`\n[测试] 端口 ${PORT}，令牌 ${token ? '已生成' : '缺失'}`);
  check('自动启动服务', !!token);

  const index = await request('GET', '/');
  check('GET / 返回 200', index.status === 200, index.status);
  check('index.html 注入了桥接配置', index.body.includes('window.__LLM_TUNER__'), index.body.slice(0, 120));
  check('注入内容包含令牌', index.body.includes(token));
  check('注入内容包含主题', /"theme":"(light|dark)"/.test(index.body), index.body.match(/"theme":"[a-z]+"/));

  const js = await request('GET', '/src/main.js');
  check('GET /src/main.js 200 + JS MIME', js.status === 200 && /javascript/.test(js.headers['content-type']), js.headers['content-type']);

  const css = await request('GET', '/styles.css');
  check('GET /styles.css 200', css.status === 200 && /css/.test(css.headers['content-type']));

  const bad = await request('GET', '/../package.json');
  check('路径穿越被拦截', bad.status === 403 || bad.status === 404, bad.status);

  const themeDark = await request('GET', '/api/theme', { token });
  check('主题接口返回 dark', JSON.parse(themeDark.body).kind === 'dark', themeDark.body);
  vscodeStub.window.activeColorTheme.kind = 1;
  const themeLight = await request('GET', '/api/theme', { token });
  check('切成浅色主题后接口同步', JSON.parse(themeLight.body).kind === 'light', themeLight.body);
  vscodeStub.window.activeColorTheme.kind = 2;

  const noAuth = await request('GET', '/api/ping');
  check('无令牌访问 API 返回 401', noAuth.status === 401, noAuth.status);

  const ping = await request('GET', '/api/ping', { token });
  const pingJson = JSON.parse(ping.body);
  check('带令牌 ping 成功', ping.status === 200 && pingJson.ok === true, ping.body);
  check('ping 返回工作区根目录', pingJson.root === wsRoot, pingJson.root);

  const pre = await request('OPTIONS', '/api/fs/list', { headers: { Origin: 'http://127.0.0.1:5173' } });
  check(
    'CORS 预检返回 204 且回显回环 Origin',
    pre.status === 204 && pre.headers['access-control-allow-origin'] === 'http://127.0.0.1:5173',
    `${pre.status} ${pre.headers['access-control-allow-origin']}`
  );

  const list = await request('POST', '/api/fs/list', { token, body: {}, headers: { Origin: 'http://127.0.0.1:5173' } });
  const files = JSON.parse(list.body).files;
  check('列出源码只含 .c/.h', files.length === 1 && files[0] === 'motor.c', JSON.stringify(files));

  const read = await request('POST', '/api/fs/read', { token, body: { path: 'motor.c' } });
  check('读取文件内容', JSON.parse(read.body).text.includes('speed_pid_kp'));

  const readBad = await request('POST', '/api/fs/read', { token, body: { path: '../../../etc/passwd' } });
  check('读取越界被拒绝', readBad.status === 400, readBad.status);

  const write = await request('POST', '/api/fs/write', {
    token,
    body: { path: 'motor.c', text: 'static float speed_pid_kp = 2.5f;\n' },
  });
  check('写入文件成功', write.status === 200 && JSON.parse(write.body).ok === true, write.body);
  check('写入落到磁盘', fs.readFileSync(path.join(wsRoot, 'motor.c'), 'utf8').includes('2.5f'));

  const writeBad = await request('POST', '/api/fs/write', { token, body: { path: '../hack.c', text: 'x' } });
  check('写入越界被拒绝', writeBad.status === 400, writeBad.status);

  ext.deactivate ? null : null;
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(wsRoot, { recursive: true, force: true });

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('测试异常', e);
  process.exit(1);
});
