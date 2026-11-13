/**
 * 源码映射：把下位机参数表（tuner_add_arg 调用点）与 C 源码里的变量对应起来，
 * 并支持把调好的值写回变量初始化处。
 */

const TYPE_TOKENS = [
  'TUNER_ARG_TYPE_INT8',
  'TUNER_ARG_TYPE_INT16',
  'TUNER_ARG_TYPE_INT32',
  'TUNER_ARG_TYPE_UINT8',
  'TUNER_ARG_TYPE_UINT16',
  'TUNER_ARG_TYPE_UINT32',
  'TUNER_ARG_TYPE_FLOAT',
  'TUNER_ARG_TYPE_DOUBLE',
];

export const ATTR_READ = 1;
export const ATTR_WRITE = 2;
export const ATTR_TRANS = 4;

const NUM_RE = /[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?[fFlLuU]*/;

export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** 从起始位置切出顶层实参（考虑字符串、字符、括号） */
function splitArgs(text, openParen) {
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  let i = openParen;
  let inStr = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === (inStr === 1 ? '"' : "'")) inStr = 0;
      continue;
    }
    if (c === '"') {
      inStr = 1;
      continue;
    }
    if (c === "'") {
      inStr = 2;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i));
        return { args, end: i };
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return { args, end: -1 };
}

function unquote(lit) {
  const m = lit.trim().match(/^"((?:[^"\\]|\\.)*)"$/s);
  if (!m) return null;
  return m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '0': '\0' }[c] ?? c));
}

function parseAttr(expr) {
  let attr = 0;
  if (/\bTUNER_ARG_ATTR_READ\b/.test(expr)) attr |= ATTR_READ;
  if (/\bTUNER_ARG_ATTR_WRITE\b/.test(expr)) attr |= ATTR_WRITE;
  if (/\bTUNER_ARG_ATTR_TRANS\b/.test(expr)) attr |= ATTR_TRANS;
  return attr;
}

/** 找 &变量 或 (void*)&变量 里的变量表达式 */
function parseTarget(expr) {
  let s = expr.trim();
  s = s.replace(/^\s*\(\s*(?:void|uint\d+_t|int\d+_t|char|float|double|const\s+\w+)\s*\*\s*\)\s*/i, '');
  s = s.replace(/^&\s*/, '');
  if (!/^[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*(?:\[[^\]]*\])*)*$/.test(s)) return null;
  return s.replace(/\s+/g, '');
}

/**
 * 扫描一个文件里的 tuner_add_arg(...) 调用
 * @returns {Array} [{name, desc, type, attr, target, index, line}]
 */
export function parseTunerCalls(text) {
  const out = [];
  const re = /\btuner_add_arg\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const { args, end } = splitArgs(text, open);
    if (end < 0 || args.length < 5) continue;
    const typeIdx = TYPE_TOKENS.indexOf(args[0].trim());
    const name = unquote(args[2]);
    const desc = unquote(args[3]);
    if (typeIdx < 0 || name === null) continue;
    out.push({
      index: m.index,
      line: lineOf(text, m.index),
      type: typeIdx,
      attr: parseAttr(args[1]),
      name,
      desc: desc === null ? '' : desc,
      target: parseTarget(args[4]),
      rawTarget: args[4].trim(),
    });
  }
  return out;
}

/** target 可能是 a.b 这种成员，也接受单独的 b */
function targetPatterns(target) {
  const parts = target.split(/(\.|->)/).filter((p) => p !== '.' && p !== '->');
  const leaf = parts[parts.length - 1].replace(/\[[^\]]*\]$/, '');
  const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedFull = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const eq = '(?<![=!<>+\\-*/%&|^])=(?!=)';
  const num = `(${NUM_RE.source})`;
  const pats = [];
  if (parts.length > 1) {
    pats.push(new RegExp(`\\b${escapedFull}\\s*${eq}\\s*${num}`, 'm'));
    pats.push(new RegExp(`\\.\\s*${escapedLeaf}\\s*${eq}\\s*${num}`, 'm'));
  }
  pats.push(new RegExp(`\\b${escapedLeaf}\\s*${eq}\\s*${num}`, 'm'));
  pats.push(new RegExp(`^\\s*#\\s*define\\s+${escapedLeaf}\\s+${num}`, 'm'));
  return pats;
}

/**
 * 在候选文件里找变量初始化处的数值
 * @returns {null | {file, index, start, end, text, value, isFloat}}
 */
export function findInitValue(files, target, preferFile) {
  if (!target) return null;
  const pats = targetPatterns(target);
  const ordered = [...files];
  if (preferFile) {
    ordered.sort((a, b) => (a.path === preferFile ? -1 : b.path === preferFile ? 1 : 0));
  }
  for (const pat of pats) {
    for (const f of ordered) {
      const m = f.text.match(pat);
      if (!m) continue;
      // 计算数值在原文中的绝对位置
      const numText = m[1];
      const at = m.index + m[0].lastIndexOf(numText);
      // 跳过注释里的内容
      if (isInComment(f.text, at)) continue;
      const value = parseFloat(numText);
      if (!Number.isFinite(value)) continue;
      const isFloat = /[fF]$/.test(numText) || /[.]/.test(numText);
      return {
        file: f.path,
        index: at,
        start: at,
        end: at + numText.length,
        text: numText,
        line: lineOf(f.text, at),
        value,
        isFloat,
        context: lineTextOf(f.text, at),
      };
    }
  }
  return null;
}

function isInComment(text, index) {
  let i = 0;
  let inBlock = false;
  for (; i < index; i++) {
    const c = text[i];
    if (inBlock) {
      if (c === '*' && text[i + 1] === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < index && text[i] !== '\n') i++;
    }
  }
  return inBlock;
}

function lineTextOf(text, index) {
  let s = text.lastIndexOf('\n', index - 1) + 1;
  let e = text.indexOf('\n', index);
  if (e < 0) e = text.length;
  return text.slice(s, e).trim();
}

/** 数值格式化：浮点保留可读精度，尽量保持原有的 f 后缀 */
export function formatNumber(value, isFloat, oldText) {
  let s;
  if (!isFloat) {
    s = String(Math.trunc(value));
  } else {
    let str = String(Number(Number(value).toPrecision(7)));
    if (!/[.eE]/.test(str)) str += '.0';
    s = str;
  }
  if (oldText && /[fF]$/.test(oldText) && !/[fF]$/.test(s)) s += 'f';
  return s;
}

/**
 * 扫描整个工程，产出参数 → 代码位置 的映射
 * @param {Array<{path, text}>} files
 */
export function buildCodeMap(files) {
  const calls = [];
  for (const f of files) {
    for (const c of parseTunerCalls(f.text)) {
      calls.push({ ...c, file: f.path });
    }
  }
  const byName = new Map();
  for (const c of calls) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const entries = calls.map((c) => {
    const init = findInitValue(files, c.target, c.file);
    return { call: c, init };
  });
  return { calls, byName, entries };
}

/**
 * 计算写回编辑（同文件多处修改按位置倒序应用）
 * @param {Array<{path, text}>} files
 * @param {Array<{name, value}>} assignments
 */
export function planEdits(files, assignments) {
  const map = buildCodeMap(files);
  const edits = [];
  const missing = [];
  for (const a of assignments) {
    const call = (map.byName.get(a.name) || [])[0];
    if (!call) {
      missing.push({ name: a.name, reason: '源码里没有找到同名参数' });
      continue;
    }
    const init = findInitValue(files, call.target, call.file);
    if (!init) {
      missing.push({ name: a.name, reason: `没找到 ${call.target || '?'} 的初始化` });
      continue;
    }
    const file = files.find((f) => f.path === init.file);
    const newText = formatNumber(a.value, init.isFloat, init.text);
    if (newText === init.text) continue;
    edits.push({
      name: a.name,
      file: init.file,
      line: init.line,
      start: init.start,
      end: init.end,
      oldText: init.text,
      newText,
      oldLine: init.context,
      newLine: init.context.replace(init.text, newText),
      target: call.target,
    });
  }
  return { edits, missing };
}

/** 应用编辑，返回 [{path, text}] */
export function applyEdits(files, edits) {
  const byFile = new Map();
  for (const e of edits) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push(e);
  }
  const out = [];
  for (const [path, list] of byFile) {
    const src = files.find((f) => f.path === path);
    if (!src) continue;
    let text = src.text;
    for (const e of [...list].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.newText + text.slice(e.end);
    }
    out.push({ path, text });
  }
  return out;
}

/** 单个文件的改动预览 */
export function diffPreview(edits) {
  return edits
    .map((e) => `${e.file}:${e.line}\n  - ${e.oldLine}\n  + ${e.newLine}`)
    .join('\n\n');
}
