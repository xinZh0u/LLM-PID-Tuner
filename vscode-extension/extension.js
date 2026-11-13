// LLM_Tuner 扩展
// 1) 活动栏放一个图标，点开即用 VS Code 内置浏览器打开网页版上位机
// 2) 起一个只监听 127.0.0.1 的本地服务：托管网页 + 给网页提供工作区源码读写接口
// 无任何 npm 依赖。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vscode = require('vscode');

const SRC_EXT = new Set(['.c', '.h', '.cpp', '.hpp', '.cc', '.hh']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.settings', 'build', 'Build', 'Debug', 'Release',
  'out', 'Drivers', 'Middlewares', 'CMSIS', 'HAL_Driver', 'obj', 'bin',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const state = {
  server: null,
  port: 5173,
  token: '',
  webRoot: null,
  output: null,
  statusBar: null,
  provider: null,
  lastError: '',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function cfg() {
  try {
    return vscode.workspace.getConfiguration('llmTuner');
  } catch (_) {
    return { get: () => undefined };
  }
}

function workspaceRoot() {
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return null;
    return folders[0].uri.fsPath;
  } catch (_) {
    return null;
  }
}

function getToken(context) {
  let token = context.globalState.get('llmTuner.token');
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    context.globalState.update('llmTuner.token', token);
  }
  return token;
}

function resolveWebRoot(context) {
  const custom = cfg().get('webRoot');
  if (custom && fs.existsSync(path.join(custom, 'index.html'))) return custom;
  const bundled = path.join(context.extensionPath, 'web');
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled;
  // 开发模式：扩展目录的上一级就是网页工程
  const parent = path.dirname(context.extensionPath);
  if (fs.existsSync(path.join(parent, 'index.html'))) return parent;
  return null;
}

function walkSources(root, maxFiles) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(path.join(dir, e.name));
      } else if (SRC_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

function safeResolve(root, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('缺少 path');
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) throw new Error('路径越界');
  return abs;
}

function json(res, code, obj, origin) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'content-type, authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Max-Age'] = '600';
  }
  res.writeHead(code, headers);
  res.end(body);
}

function isLoopbackOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin || '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

async function writeThroughVscode(abs, text) {
  let docs = [];
  try {
    docs = vscode.workspace.textDocuments || [];
  } catch (_) {}
  const doc = docs.find((d) => d.uri && d.uri.fsPath === abs);
  if (!doc) {
    fs.writeFileSync(abs, text, 'utf8');
    return 'disk';
  }
  const edit = new vscode.WorkspaceEdit();
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, full, text);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error('编辑器拒绝应用修改');
  await doc.save();
  return 'editor';
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, urlPath) {
  const root = state.webRoot;
  if (!root) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('网页资源缺失：扩展里没有 web/ 目录，可用 llmTuner.webRoot 指定');
    return;
  }
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.resolve(root, '.' + rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (file !== root && !file.startsWith(rootWithSep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + rel);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html') {
      const inject =
        '<script>window.__LLM_TUNER__=' +
        JSON.stringify({
          api: { base: '/api', token: state.token },
          port: state.port,
          theme: themeKind(),
        }) +
        ';</script>';
      let html = data.toString('utf8');
      html = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;
      const body = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handleApi(req, res, urlPath, origin) {
  const allowOrigin = isLoopbackOrigin(origin) ? origin : '*';
  if (req.method === 'OPTIONS') {
    return json(res, 204, {}, allowOrigin);
  }
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + state.token) {
    return json(res, 401, { error: '令牌无效' }, allowOrigin);
  }

  const root = workspaceRoot();
  const route = urlPath.slice('/api'.length);

  try {
    if (route === '/ping') {
      return json(res, 200, { ok: true, root, port: state.port, version: 1, webRoot: state.webRoot, theme: themeKind() }, allowOrigin);
    }
    if (route === '/theme' && (req.method === 'GET' || req.method === 'POST')) {
      return json(res, 200, { kind: themeKind(), port: state.port }, allowOrigin);
    }
    if (!root) return json(res, 409, { error: '没有打开的工作区' }, allowOrigin);

    if (route === '/fs/list' && req.method === 'POST') {
      const maxFiles = Number(cfg().get('maxFiles')) || 800;
      return json(res, 200, { root, files: walkSources(root, maxFiles) }, allowOrigin);
    }
    if (route === '/fs/read' && req.method === 'POST') {
      const body = await readBody(req);
      const abs = safeResolve(root, body.path);
      return json(res, 200, { path: body.path, text: fs.readFileSync(abs, 'utf8') }, allowOrigin);
    }
    if (route === '/fs/write' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.text !== 'string') return json(res, 400, { error: '缺少 text' }, allowOrigin);
      const abs = safeResolve(root, body.path);
      const how = await writeThroughVscode(abs, body.text);
      state.output.appendLine(`[write:${how}] ${body.path}`);
      return json(res, 200, { ok: true, path: body.path, via: how }, allowOrigin);
    }
    return json(res, 404, { error: '未知接口 ' + urlPath }, allowOrigin);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    state.output.appendLine(`[error] ${urlPath} ${msg}`);
    return json(res, 400, { error: msg }, allowOrigin);
  }
}

function startServer(context) {
  const port = Number(cfg().get('port')) || 5173;
  state.port = port;
  state.token = getToken(context);
  state.webRoot = resolveWebRoot(context);

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    let urlPath = '/';
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0]) || '/';
    } catch (_) {}

    if (urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath, origin).catch((e) => {
        try {
          json(res, 500, { error: String(e) }, '*');
        } catch (_) {}
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    serveStatic(req, res, urlPath);
  });

  server.on('error', (e) => {
    state.lastError = e.message;
    state.output.appendLine(`[server] ${e.message}`);
    if (state.statusBar) state.statusBar.text = '$(alert) LLM_Tuner: 端口被占用';
    vscode.window.showWarningMessage(
      `LLM_Tuner 本地服务启动失败：${e.message}（端口 ${port}，可在设置 llmTuner.port 里改）`
    );
  });

  server.listen(port, '127.0.0.1', () => {
    state.lastError = '';
    state.server = server;
    state.output.appendLine(`服务已启动: http://127.0.0.1:${port}`);
    state.output.appendLine(`网页目录: ${state.webRoot || '(缺失)'}`);
    state.output.appendLine(`工作区: ${workspaceRoot() || '(未打开)'}`);
    state.output.appendLine(`令牌: ${state.token}`);
    if (state.statusBar) {
      state.statusBar.text = '$(pulse) LLM_Tuner: ' + port;
      state.statusBar.tooltip = `http://127.0.0.1:${port}`;
      state.statusBar.show();
    }
    if (state.provider) state.provider.refresh();
  });
}

function stopServer() {
  if (state.server) {
    try {
      state.server.close();
    } catch (_) {}
    state.server = null;
  }
  if (state.statusBar) state.statusBar.text = '$(debug-disconnect) LLM_Tuner: 已停止';
}

function appUrl() {
  return `http://127.0.0.1:${state.port}/`;
}

/** VS Code 当前配色方案 → light / dark */
function themeKind() {
  try {
    const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
    // 1 = Light, 4 = HighContrastLight
    return kind === 1 || kind === 4 ? 'light' : 'dark';
  } catch (_) {
    return 'dark';
  }
}

/* ------------------------------------------------------------------ */
/* 侧边栏启动面板（活动栏图标点开的地方）                                 */
/* ------------------------------------------------------------------ */

function launcherHtml() {
  const nonce = crypto.randomBytes(8).toString('hex');
  const running = !!state.server;
  const root = workspaceRoot() || '（未打开文件夹）';
  const status = running
    ? `服务运行中 · 127.0.0.1:${state.port}`
    : state.lastError
    ? `服务启动失败：${state.lastError}`
    : '服务未启动';
  const color = running ? 'var(--vscode-charts-green)' : 'var(--vscode-errorForeground)';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
         padding: 12px 12px 16px; }
  h3 { font-size: 12px; font-weight: 600; margin: 0 0 10px; letter-spacing: .3px; }
  .status { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; color: ${color}; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: 0 0 8px; }
  .meta { color: var(--vscode-descriptionForeground); line-height: 1.6; margin-bottom: 14px;
          word-break: break-all; }
  button { display: block; width: 100%; margin-bottom: 8px; padding: 6px 10px; cursor: pointer;
           border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent);
           background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
           font-family: inherit; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .tip { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border);
         color: var(--vscode-descriptionForeground); line-height: 1.6; }
  code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
  <h3>LLM_Tuner 上位机</h3>
  <div class="status"><span class="dot"></span><span>${status}</span></div>
  <div class="meta">
    工作区：${root}<br>
    网页：<code>${appUrl()}</code>
  </div>
  <button class="primary" id="open">在内置浏览器中打开</button>
  <button id="ext">在系统浏览器中打开（串口可用）</button>
  <button id="token">复制桥接令牌</button>
  <button id="restart">重启服务</button>
  <div class="tip">
    VS Code 内置浏览器基于 iframe，通常拿不到 Web Serial 权限。
    如果打开后面板提示「浏览器不支持 Web Serial」，请改用系统浏览器打开，
    数据通路与「工程/代码」桥接完全一样。
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const bind = (id, cmd) => document.getElementById(id).addEventListener('click', () => vscode.postMessage({ cmd }));
  bind('open', 'llmTuner.open');
  bind('ext', 'llmTuner.openExternal');
  bind('token', 'llmTuner.copyToken');
  bind('restart', 'llmTuner.restart');
</script>
</body>
</html>`;
}

class LauncherProvider {
  constructor() {
    this.view = null;
    this.autoOpened = false;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = launcherHtml();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg && typeof msg.cmd === 'string') {
        vscode.commands.executeCommand(msg.cmd);
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        view.webview.html = launcherHtml();
        this.maybeAutoOpen();
      }
    });
    this.maybeAutoOpen();
  }

  refresh() {
    if (this.view) this.view.webview.html = launcherHtml();
  }

  maybeAutoOpen() {
    if (this.autoOpened) return;
    if (cfg().get('autoOpen') === false) return;
    this.autoOpened = true;
    setTimeout(() => {
      vscode.commands.executeCommand('llmTuner.open');
    }, 150);
  }
}

/* ------------------------------------------------------------------ */
/* 激活                                                                */
/* ------------------------------------------------------------------ */

function activate(context) {
  state.output = vscode.window.createOutputChannel('LLM_Tuner');
  context.subscriptions.push(state.output);

  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  state.statusBar.command = 'llmTuner.showInfo';
  context.subscriptions.push(state.statusBar);

  state.provider = new LauncherProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('llmTuner.panel', state.provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llmTuner.open', async () => {
      if (!state.server) startServer(context);
      const url = appUrl();
      try {
        await vscode.commands.executeCommand('simpleBrowser.show', url);
      } catch (_) {
        try {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(url));
        } catch (_) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llmTuner.openExternal', async () => {
      if (!state.server) startServer(context);
      await vscode.env.openExternal(vscode.Uri.parse(appUrl()));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llmTuner.copyToken', async () => {
      await vscode.env.clipboard.writeText(state.token || getToken(context));
      vscode.window.showInformationMessage('LLM_Tuner 桥接令牌已复制');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llmTuner.showInfo', async () => {
      const choice = await vscode.window.showInformationMessage(
        `服务：${state.server ? appUrl() : '未启动'}\n工作区：${workspaceRoot() || '(无)'}\n令牌：${state.token}`,
        '在内置浏览器中打开',
        '复制令牌',
        '打开输出'
      );
      if (choice === '在内置浏览器中打开') vscode.commands.executeCommand('llmTuner.open');
      else if (choice === '复制令牌') vscode.commands.executeCommand('llmTuner.copyToken');
      else if (choice === '打开输出') state.output.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('llmTuner.restart', () => {
      stopServer();
      startServer(context);
      vscode.window.showInformationMessage('LLM_Tuner 本地服务已重启');
    })
  );

  if (cfg().get('autoStart') !== false) startServer(context);

  context.subscriptions.push({ dispose: stopServer });
  return { getPort: () => state.port, isRunning: () => !!state.server };
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
