const LS_KEY = 'llmtuner.agent.v1';

const SYSTEM_PROMPT = `你是嵌入式调试助手，连接在一个 STM32 参数调参上位机上。
- 下位机通过自定义串口协议上报参数表（索引、名称、类型、说明）和参数值。
- 你可以用 list_params 查看参数，read_values 读值，get_samples 取历史采样，
  get_stats 做统计，set_param 直接给参数写值（单位与下位机一致），
  set_transmit 控制下位机回传哪些参数，raw_write 发送原始字节。
- 调参时先读数据、再小步调整、每步后重新采样确认效果，避免大幅跳变导致失控。
- 如果用户已在「工程」面板挂载了下位机源码，可以用 list_source_files / read_source_file /
  find_param_code 查看参数对应的变量、初始化值和所在文件，必要时据此解释参数含义。
- 回答用中文，简洁，给出你依据的数据（数值、超调量、跟踪误差等）。`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_params',
      description: '列出参数表：索引、名称、说明、类型、是否可写、当前值',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_values',
      description: '读取参数的最新值',
      parameters: {
        type: 'object',
        properties: {
          indices: { type: 'array', items: { type: 'integer' }, description: '参数索引；省略则返回全部' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_samples',
      description: '获取某参数最近的采样序列（降采样到最多 200 点）',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '参数索引' },
          count: { type: 'integer', description: '取最近多少个采样点，默认 200' },
        },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stats',
      description: '统计某参数最近窗口的 min/max/mean/std/首尾值，可选给出目标值计算超调与稳态误差',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          window: { type: 'number', description: '统计窗口（秒），默认 10' },
          target: { type: 'number', description: '参考目标值，用于计算超调' },
        },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_param',
      description: '向下位机发送调参包，把某个参数设置为给定数值',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '参数索引' },
          value: { type: 'number', description: '目标数值' },
        },
        required: ['index', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_transmit',
      description: '设置下位机要回传的参数集合（会立即下发位图）',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['set', 'all', 'none'], description: 'set=按 indices；all=全部；none=全部关闭' },
          indices: { type: 'array', items: { type: 'integer' }, description: 'mode=set 时有效' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'raw_write',
      description: '直接向串口写原始数据，调试或 RAW 模式下使用',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          hex: { type: 'boolean', description: 'true 表示 text 是十六进制字节串' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_status',
      description: '读取连接状态、接收速率、帧率、CRC 错误数、参数个数',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_source_files',
      description: '列出已挂载工程里的 C 源文件（需要用户在「工程」面板里先授权目录或连接桥接）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source_file',
      description: '读取工程里某个源文件的文本内容',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工程根目录的路径，如 App/motor.c' },
          max_chars: { type: 'integer', description: '最多返回多少字符，默认 12000' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_param_code',
      description: '查询参数在源码里的位置：tuner_add_arg 调用处、目标变量、初始化值、当前在线值',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '参数名；省略则返回全部' },
        },
        required: [],
      },
    },
  },
];

export function initAgent(app) {
  const $drawer = document.getElementById('agentDrawer');
  const $base = document.getElementById('agBase');
  const $model = document.getElementById('agModel');
  const $key = document.getElementById('agKey');
  const $steps = document.getElementById('agSteps');
  const $goal = document.getElementById('agGoal');
  const $run = document.getElementById('agRun');
  const $stop = document.getElementById('agStop');
  const $clear = document.getElementById('agClear');
  const $log = document.getElementById('agLog');

  const cfg = loadCfg();
  $base.value = cfg.baseUrl;
  $model.value = cfg.model;
  $key.value = cfg.apiKey;
  $steps.value = cfg.maxSteps;

  const saveCfg = () => {
    save({
      baseUrl: $base.value.trim(),
      model: $model.value.trim(),
      apiKey: $key.value.trim(),
      maxSteps: Number($steps.value) || 8,
    });
  };
  [$base, $model, $key, $steps].forEach((el) => el.addEventListener('change', saveCfg));

  document.getElementById('agentBtn').addEventListener('click', () => {
    $drawer.hidden = !$drawer.hidden;
  });
  document.getElementById('agentClose').addEventListener('click', () => {
    $drawer.hidden = true;
  });
  $clear.addEventListener('click', () => {
    $log.innerHTML = '';
  });

  let abort = null;

  const log = (kind, text, extra) => {
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    if (extra) {
      div.innerHTML = `<div>${escapeHtml(text)}</div>`;
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = extra.title;
      const pre = document.createElement('pre');
      pre.textContent = extra.body;
      d.appendChild(s);
      d.appendChild(pre);
      div.appendChild(d);
    } else {
      div.textContent = text;
    }
    $log.appendChild(div);
    $drawer.querySelector('.agent-body').scrollTop = 1e9;
    return div;
  };

  async function chat(messages, tools) {
    const base = $base.value.trim().replace(/\/+$/, '');
    const model = $model.value.trim();
    if (!base || !model) throw new Error('请先填写 Base URL 与模型名');
    const headers = { 'Content-Type': 'application/json' };
    const key = $key.value.trim();
    if (key) headers.Authorization = 'Bearer ' + key;

    const body = { model, messages, temperature: 0.2 };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 400)}`);
    }
    const json = await res.json();
    const choice = json.choices && json.choices[0];
    if (!choice) throw new Error('接口未返回 choices');
    return choice.message;
  }

  function execTool(name, argsJson) {
    let args = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch (_) {
      args = {};
    }
    const hub = app.hub;
    const page = app.activePage();

    switch (name) {
      case 'list_params':
        return {
          connected: app.conn.connected,
          params: hub.params.map((p) => ({
            index: p.index,
            name: p.name,
            desc: p.desc,
            type: p.type === null ? 'unknown' : ['int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32', 'float', 'double'][p.type],
            writable: p.writable,
            value: round(p.ring.last()),
          })),
        };
      case 'read_values': {
        const idxs = Array.isArray(args.indices) ? args.indices : hub.params.map((p) => p.index);
        return {
          values: idxs
            .map((i) => hub.params[i])
            .filter(Boolean)
            .map((p) => ({ index: p.index, name: p.name, value: round(p.ring.last()) })),
        };
      }
      case 'get_samples': {
        const p = hub.params[args.index];
        if (!p) return { error: '参数不存在' };
        const count = Math.min(2000, Math.max(2, args.count || 200));
        const ring = p.ring;
        const n = Math.min(ring.count, count);
        const stride = Math.max(1, Math.floor(ring.count / n));
        const out = [];
        for (let i = ring.count - n * stride; i < ring.count; i += stride) {
          if (i < 0) continue;
          out.push([Number(ring.tAt(i).toFixed(3)), round(ring.vAt(i))]);
        }
        return { index: p.index, name: p.name, samples: out, total: ring.count };
      }
      case 'get_stats': {
        const p = hub.params[args.index];
        if (!p) return { error: '参数不存在' };
        const win = Math.max(0.1, args.window || 10);
        const ring = p.ring;
        const i0 = ring.indexAt(ring.lastT() - win);
        const vals = [];
        for (let i = i0; i < ring.count; i++) {
          const v = ring.vAt(i);
          if (Number.isFinite(v)) vals.push(v);
        }
        if (!vals.length) return { error: '窗口内没有数据' };
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (const v of vals) {
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
        }
        const mean = sum / vals.length;
        let sq = 0;
        for (const v of vals) sq += (v - mean) * (v - mean);
        const res = {
          index: p.index,
          name: p.name,
          count: vals.length,
          window: win,
          min: round(min),
          max: round(max),
          mean: round(mean),
          std: round(Math.sqrt(sq / vals.length)),
          first: round(vals[0]),
          last: round(vals[vals.length - 1]),
        };
        if (Number.isFinite(args.target)) {
          const dir = Math.sign(args.target - vals[0]) || 1;
          res.target = args.target;
          res.overshoot = round(((dir > 0 ? max - args.target : args.target - min) / Math.abs(args.target || 1)) * 100);
          res.steady_error = round(args.target - vals[vals.length - 1]);
        }
        return res;
      }
      case 'set_param': {
        const p = hub.params[args.index];
        if (!p) return { error: '参数不存在' };
        if (!p.writable) return { error: '该参数不具有写属性' };
        if (!app.conn.connected) return { error: '串口未连接' };
        const ok = hub.sendTuning(args.index, Number(args.value));
        return { ok, index: args.index, sent: args.value };
      }
      case 'set_transmit': {
        const n = hub.params.length;
        if (!n) return { error: '参数表为空' };
        const flags = new Array(n).fill(false);
        if (args.mode === 'all') flags.fill(true);
        else if (args.mode === 'set') for (const i of args.indices || []) if (i >= 0 && i < n) flags[i] = true;
        hub.sendTransSet(flags);
        return { ok: true, transmitting: flags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0) };
      }
      case 'raw_write': {
        let bytes;
        if (args.hex) {
          const clean = String(args.text || '').replace(/0x/gi, '').replace(/[\s,]+/g, '');
          bytes = new Uint8Array(clean.length / 2);
          for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
        } else {
          const eol = page && page.format === 'raw' ? '\n' : '';
          bytes = new TextEncoder().encode(String(args.text || '') + eol);
        }
        app.conn.write(bytes);
        return { ok: true, bytes: bytes.length };
      }
      case 'get_status': {
        const s = hub.stats;
        return {
          connected: app.conn.connected,
          source: app.conn.portKey,
          rx: s.rx,
          tx: s.tx,
          bytesPerSec: s.rate,
          frameRate: s.frameRate,
          crcErrors: s.crcErrors,
          paramCount: hub.params.length,
          desync: s.desync,
          pageFormat: page ? page.format : null,
          project: app.project && app.project.ready ? app.project.backend.name : null,
        };
      }
      case 'list_source_files': {
        const proj = app.project;
        if (!proj || !proj.files.length) return { error: '尚未挂载工程（在「工程」面板选择目录或连接桥接）' };
        return { root: proj.backend.name, files: proj.files.map((f) => f.path) };
      }
      case 'read_source_file': {
        const proj = app.project;
        if (!proj || !proj.files.length) return { error: '尚未挂载工程' };
        const file = proj.files.find((f) => f.path === args.path);
        if (!file) return { error: '文件不存在：' + args.path };
        const maxChars = Math.min(60000, Math.max(500, args.max_chars || 12000));
        return {
          path: file.path,
          chars: file.text.length,
          truncated: file.text.length > maxChars,
          text: file.text.slice(0, maxChars),
        };
      }
      case 'find_param_code': {
        const proj = app.project;
        if (!proj || !proj.map) return { error: '尚未挂载工程' };
        let rows = proj.rows();
        if (args.name) rows = rows.filter((r) => r.name === args.name);
        return {
          rows: rows.map((r) => ({
            name: r.name,
            desc: r.desc,
            target: r.target,
            file: r.file,
            line: r.line,
            codeValue: r.codeValue,
            liveValue: r.live,
          })),
        };
      }
      default:
        return { error: '未知工具: ' + name };
    }
  }

  $stop.addEventListener('click', () => {
    if (abort) abort.abort();
  });

  $run.addEventListener('click', async () => {
    const goal = $goal.value.trim();
    if (!goal) {
      log('err', '请先填写目的');
      return;
    }
    if (!$log.querySelector('.msg.user')) log('user', goal);
    else log('user', goal);

    abort = new AbortController();
    $run.disabled = true;
    $stop.disabled = false;

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: goal },
    ];
    const maxSteps = Math.max(1, Math.min(20, Number($steps.value) || 8));

    try {
      for (let step = 0; step < maxSteps; step++) {
        const msg = await chat(messages, TOOLS);
        const toolCalls = msg.tool_calls || [];
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: toolCalls.length ? toolCalls : undefined });
        if (msg.content) log('assistant', msg.content);

        if (!toolCalls.length) break;

        for (const call of toolCalls) {
          const name = call.function && call.function.name;
          const args = call.function && call.function.arguments;
          let result;
          try {
            result = execTool(name, args);
          } catch (e) {
            result = { error: String(e && e.message ? e.message : e) };
          }
          const body = JSON.stringify(result, null, 2);
          log('tool', `⚙ ${name}(${args || ''})`, { title: '结果', body: body.slice(0, 4000) });
          messages.push({ role: 'tool', tool_call_id: call.id, content: body.slice(0, 8000) });
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') log('err', '已停止');
      else log('err', String(e && e.message ? e.message : e));
    } finally {
      $run.disabled = false;
      $stop.disabled = true;
      abort = null;
    }
  });

  return { open: () => ($drawer.hidden = false) };
}

function round(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 1e6) / 1e6;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function loadCfg() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      return {
        baseUrl: o.baseUrl || 'https://api.deepseek.com/v1',
        model: o.model || 'deepseek-chat',
        apiKey: o.apiKey || '',
        maxSteps: o.maxSteps || 8,
      };
    }
  } catch (_) {}
  return { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', maxSteps: 8 };
}

function save(obj) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch (_) {}
}
