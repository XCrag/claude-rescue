#!/usr/bin/env node
'use strict';

/**
 * claude-rescue — 查看并接管 Claude Code 会话的终端小工具。
 *
 * 跨平台(macOS / Windows / Linux),零依赖。
 *
 * 会话状态文件位于  <config>/sessions/<pid>.json,其中 <config> 为:
 *   - $CLAUDE_CONFIG_DIR        若设置了该环境变量
 *   - ~/.claude                 否则
 * os.homedir() 在 Windows 解析为 %USERPROFILE%,在 macOS/Linux 解析为 $HOME,
 * 因此同一份代码在各平台都能找到目录。
 *
 * 注意:该目录只包含"正在运行"的会话,会话退出后文件即被清除。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '1.0.0';

/* ================================================================== *
 * Paths
 * ================================================================== */

function expandHome(p) {
  if (typeof p === 'string' && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function getConfigDir() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return expandHome(env.trim());
  return path.join(os.homedir(), '.claude');
}

function getSessionsDir() {
  return path.join(getConfigDir(), 'sessions');
}

/* ================================================================== *
 * Process liveness — process.kill(pid, 0) just probes existence.
 * ================================================================== */

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

/* ================================================================== *
 * Load + sort sessions
 * ================================================================== */

function loadSessions(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { sessions: [], missing: true };
    throw e;
  }

  const sessions = [];
  for (const fname of entries) {
    if (!fname.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(dir, fname);

    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (!stat.isFile()) continue;

    let data = {};
    let parseError = null;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data === null || typeof data !== 'object') { data = {}; parseError = 'not an object'; }
    } catch (e) {
      parseError = e.message;
    }

    let pid = Number.isInteger(data.pid) ? data.pid : parseInt(path.basename(fname, '.json'), 10);
    if (!Number.isFinite(pid)) pid = null;

    sessions.push({
      file: fname,
      filePath,
      pid,
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : null,
      name: typeof data.name === 'string' ? data.name : null,
      cwd: typeof data.cwd === 'string' ? data.cwd : null,
      status: typeof data.status === 'string' ? data.status : null,
      kind: typeof data.kind === 'string' ? data.kind : null,
      version: typeof data.version === 'string' ? data.version : null,
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : null,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : stat.mtimeMs,
      parseError,
      alive: false,
    });
  }

  for (const s of sessions) s.alive = s.pid != null && isAlive(s.pid);
  return { sessions, missing: false };
}

function sortSessions(list, mode) {
  const a = list.slice();
  if (mode === 'name') {
    a.sort((x, y) => (x.name || '￿').localeCompare(y.name || '￿') || (y.updatedAt || 0) - (x.updatedAt || 0));
  } else if (mode === 'cwd') {
    a.sort((x, y) => (x.cwd || '￿').localeCompare(y.cwd || '￿') || (y.updatedAt || 0) - (x.updatedAt || 0));
  } else {
    a.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0)); // recent
  }
  return a;
}

/* ================================================================== *
 * 异常检测
 *   读取会话的 transcript(projects/<编码cwd>/<sessionId>.jsonl)末尾,
 *   判断会话是否卡在错误上。目前识别: 最后一条 assistant 消息是 API 错误
 *   (isApiErrorMessage:true),例如 "API Error: 524 ... timeout"。
 * ================================================================== */

const _abnormalCache = new Map(); // transcript 路径 -> { mtimeMs, size, result }

// 定位某个会话的 transcript 文件。先按 cwd 推导路径(最快),失败再遍历兜底。
function findTranscript(sessionId, cwd, projectsDir) {
  if (!sessionId) return null;
  if (cwd) {
    const guess = path.join(projectsDir, cwd.replace(/\//g, '-'), sessionId + '.jsonl');
    try { if (fs.statSync(guess).isFile()) return guess; } catch { /* fall through */ }
  }
  let dirs;
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(projectsDir, d, sessionId + '.jsonl');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  return null;
}

// 读取文件末尾最多 maxBytes 字节,返回完整的行(丢弃被截断的首行)。
function readTailLines(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString('utf8');
    if (start > 0) { const nl = s.indexOf('\n'); if (nl >= 0) s = s.slice(nl + 1); }
    return s.split('\n').filter((l) => l.trim());
  } finally { fs.closeSync(fd); }
}

// 会话异常分三种(kind): 'retrying'(正在 API 重试) / 'error'(已报错) / 'slow'(进程活着但长时间无响应)。
// 下面这些是非对话的元数据记录,判断"最后一条 / 最近几条实质记录"时要先跳过它们。
const META_TYPES = new Set([
  'mode', 'permission-mode', 'file-history-snapshot', 'attachment',
  'ai-title', 'last-prompt', 'custom-title', 'agent-name',
]);
const SLOW_MS = 5 * 60 * 1000; // 进程活着、但记录文件超过这个时长没更新 -> 无响应

// kind -> 状态列短标签(<= 3 个汉字,放得进 6 格宽的状态列)。
function abnormalLabel(kind) {
  return kind === 'retrying' ? '重试中'
    : kind === 'error' ? '错误'
      : kind === 'slow' ? '无响应' : '';
}

// 由一条 system/api_error 记录拼出重试原因,如 "重试 3/10 · 520"。
function retryReason(o) {
  let s = '重试';
  if (o.retryAttempt != null && o.maxRetries != null) s += ' ' + o.retryAttempt + '/' + o.maxRetries;
  const status = o.error && o.error.status;
  if (status) s += ' · ' + status;
  return s;
}

// 由一条 assistant API 错误消息拼出原因,如 "524 · Error 524: A timeout occurred"。
function errorReason(o) {
  const status = o.apiErrorStatus || '';
  let title = '';
  const c = o.message && o.message.content;
  if (Array.isArray(c)) {
    const b = c.find((x) => x && x.type === 'text' && x.text);
    if (b) {
      const m = b.text.match(/"title"\s*:\s*"([^"]+)"/);
      title = m ? m[1] : b.text.split('\n')[0].replace(/^API Error:\s*/i, '').trim().slice(0, 60);
    }
  }
  return [status, title].filter(Boolean).join(' · ') || 'API 错误';
}

// 只看 transcript 内容能判定的两种状态(retrying / error);
// 'slow' 依赖实时时间,在 annotateSessions 里叠加,不进缓存。
function detectAbnormalUncached(file) {
  let lines;
  try { lines = readTailLines(file, 262144); } catch { return { kind: 'ok', reason: null }; }
  // 解析并滤掉非对话的元数据记录,只留实质记录(user / assistant / system 等)。
  const essential = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || !o.type || META_TYPES.has(o.type)) continue;
    essential.push(o);
  }
  if (!essential.length) return { kind: 'ok', reason: null };
  // 1) 最后一条实质记录是 system/api_error -> 正在重试。
  const last = essential[essential.length - 1];
  if (last.type === 'system' && last.subtype === 'api_error') {
    return { kind: 'retrying', reason: retryReason(last) };
  }
  // 2) 最近 3 条实质记录里有 assistant 的 API 错误消息 -> 已报错
  //    (错误消息后面常跟着 turn_duration / user 等,所以不只看最后一条)。
  for (const o of essential.slice(-3)) {
    if (o.type === 'assistant' && o.isApiErrorMessage === true) {
      return { kind: 'error', reason: errorReason(o) };
    }
  }
  return { kind: 'ok', reason: null };
}

function detectAbnormal(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { kind: 'ok', reason: null }; }
  const c = _abnormalCache.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.result;
  const result = detectAbnormalUncached(file);
  _abnormalCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

// 给每个会话标注 transcript 路径与异常状态:
//   s.abnormalKind   'ok' | 'retrying' | 'error' | 'slow'
//   s.abnormal       兼容旧用法的布尔(= kind !== 'ok')
//   s.abnormalReason 详情文案(重试次数 / 状态码 / 无响应时长等)
function annotateSessions(sessions, sessionsDir) {
  const projectsDir = path.join(path.dirname(sessionsDir), 'projects');
  const now = Date.now();
  for (const s of sessions) {
    s.transcript = findTranscript(s.sessionId, s.cwd, projectsDir);
    let r = s.transcript ? detectAbnormal(s.transcript) : { kind: 'ok', reason: null };
    // 时间维度(实时,不进缓存): 内容正常、但进程活着且记录文件长时间没更新 -> 无响应。
    if (r.kind === 'ok' && s.alive && s.updatedAt && (now - s.updatedAt > SLOW_MS)) {
      r = { kind: 'slow', reason: '无响应 ' + Math.floor((now - s.updatedAt) / 60000) + ' 分钟' };
    }
    s.abnormalKind = r.kind;
    s.abnormal = r.kind !== 'ok';
    s.abnormalReason = r.reason || null;
  }
  return sessions;
}

/* ================================================================== *
 * 接管会话: 在会话目录下打开终端,启动一个全新的 Claude(不带 --resume)并发送指令
 * ================================================================== */

// 接管时发给新起会话的指令(用户指定的话术)。
function resumePrompt(sessionId) {
  return `sessionId为${sessionId}的任务卡住了，你帮我看看任务进度现在到哪里了，下一步我该做什么，请你继续执行任务。`;
}

function shellSingleQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function appleStringLiteral(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function psSingleQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// 接管时可选的命令行开关:
//   opts.skipPermissions -> 拼接 --dangerously-skip-permissions
//   opts.name            -> 拼接 --name <名字>
// 开关放在 prompt 之前,符合 CLI 习惯。返回带尾随空格的片段(无开关时为空串)。
function resumeFlagsPosix(opts) {
  const f = [];
  if (opts && opts.skipPermissions) f.push('--dangerously-skip-permissions');
  if (opts && opts.name) f.push('--name ' + shellSingleQuote(opts.name));
  return f.length ? f.join(' ') + ' ' : '';
}
function resumeFlagsWin(opts) {
  const f = [];
  if (opts && opts.skipPermissions) f.push('--dangerously-skip-permissions');
  if (opts && opts.name) f.push('--name ' + psSingleQuote(opts.name));
  return f.length ? f.join(' ') + ' ' : '';
}

// 给用户看 / 复制到剪贴板的完整命令(启动新的 Claude,不带 --resume)。
function humanResumeCommand(sessionId, opts) {
  return `claude ${resumeFlagsPosix(opts)}${shellSingleQuote(resumePrompt(sessionId))}`;
}

// 构造"在 cwd 下开终端并启动 Claude(prompt 里带上卡住的 sessionId)"的进程命令。
// 注意: 是 `claude '<prompt>'` 启动新会话,不带 --resume。
function buildResumeCommand(platform, cwd, sessionId, prompt, opts) {
  if (platform === 'win32') {
    const ps = `Set-Location -LiteralPath ${psSingleQuote(cwd)}; claude ${resumeFlagsWin(opts)}${psSingleQuote(prompt)}`;
    return { cmd: 'cmd', args: ['/c', 'start', 'claude-rescue', 'powershell', '-NoExit', '-Command', ps] };
  }
  const inner = `cd ${shellSingleQuote(cwd)} && claude ${resumeFlagsPosix(opts)}${shellSingleQuote(prompt)}`;
  if (platform === 'darwin') {
    const as = `tell application "Terminal"\nactivate\ndo script ${appleStringLiteral(inner)}\nend tell`;
    return { cmd: 'osascript', args: ['-e', as] };
  }
  return { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-c', `${inner}; exec $SHELL`] };
}

// 真正打开终端执行,返回是否成功发起。
function openTerminalAndRun(cwd, sessionId, prompt, opts) {
  const { cmd, args } = buildResumeCommand(process.platform, cwd, sessionId, prompt, opts);
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return !r.error && (r.status === 0 || r.status == null);
}

// 跨平台复制文本到剪贴板。
function copyText(text) {
  let cmd, args = [];
  if (process.platform === 'darwin') cmd = 'pbcopy';
  else if (process.platform === 'win32') cmd = 'clip';
  else { cmd = 'xclip'; args = ['-selection', 'clipboard']; }
  const r = spawnSync(cmd, args, { input: text });
  if (r.error || (r.status !== 0 && r.status != null)) throw r.error || new Error('exit ' + r.status);
  return true;
}

/* ================================================================== *
 * Formatting helpers
 * ================================================================== */

function relTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < -60000) return '未来';
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 45) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '分钟前';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '小时前';
  const d = Math.floor(h / 24);
  if (d < 30) return d + '天前';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + '个月前';
  return Math.floor(mo / 12) + '年前';
}

function fmtDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

function sortLabel(mode) {
  return mode === 'name' ? '名字' : mode === 'cwd' ? '目录' : '最近';
}

function statusLabel(s) {
  return s === 'busy' ? '忙碌' : s === 'idle' ? '空闲' : (s || '—');
}

// Display width: count CJK / fullwidth glyphs as 2 columns.
function charW(cp) {
  if (cp === 0) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}
function strW(str) {
  let w = 0;
  for (const ch of String(str)) w += charW(ch.codePointAt(0));
  return w;
}
function truncEnd(str, max) {
  str = String(str);
  if (max <= 0) return '';
  if (strW(str) <= max) return str;
  let out = '', w = 0;
  for (const ch of str) {
    const cw = charW(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch; w += cw;
  }
  return out + '…';
}
function truncStart(str, max) {
  str = String(str);
  if (max <= 0) return '';
  if (strW(str) <= max) return str;
  const chars = [...str];
  let out = '', w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charW(chars[i].codePointAt(0));
    if (w + cw > max - 1) break;
    out = chars[i] + out; w += cw;
  }
  return '…' + out;
}
function padEnd(str, max) {
  str = String(str);
  const w = strW(str);
  return w >= max ? str : str + ' '.repeat(max - w);
}

function makeColors(on) {
  const w = (a, b) => (on ? (s) => `\x1b[${a}m${s}\x1b[${b}m` : (s) => String(s));
  return {
    on: !!on,
    dim: w(2, 22), bold: w(1, 22), under: w(4, 24), inv: w(7, 27),
    red: w(31, 39), green: w(32, 39), yellow: w(33, 39),
    blue: w(34, 39), magenta: w(35, 39), cyan: w(36, 39), gray: w(90, 39),
  };
}

// Build a row as `raw` (no escapes, for measuring/inverting) and `colored`.
function composeRow(segs) {
  let raw = '', colored = '';
  for (const seg of segs) {
    let t = seg.t == null ? '' : String(seg.t);
    if (seg.w != null) t = padEnd(truncEnd(t, seg.w), seg.w);
    raw += t;
    colored += seg.c ? seg.c(t) : t;
  }
  return { raw, colored };
}

/* ================================================================== *
 * 非交互输出 (--list / --json / 管道)
 * ================================================================== */

function printPlain(sessions, opts) {
  const out = (s) => process.stdout.write(s);

  if (opts.json) {
    const arr = sessions.map((s) => ({
      sessionId: s.sessionId, name: s.name, pid: s.pid, alive: s.alive,
      cwd: s.cwd, status: s.status, abnormal: !!s.abnormal, abnormalKind: s.abnormalKind || 'ok', abnormalReason: s.abnormalReason || undefined,
      kind: s.kind, version: s.version,
      startedAt: s.startedAt, updatedAt: s.updatedAt, file: s.file,
      transcript: s.transcript || undefined, parseError: s.parseError || undefined,
    }));
    out(JSON.stringify(arr, null, 2) + '\n');
    return;
  }

  if (!sessions.length) {
    out(`目录中没有会话: ${opts.dir}\n`);
    return;
  }

  const C = makeColors(opts.color);
  const cell = (val, width, colorFn) => {
    val = String(val);
    const pad = ' '.repeat(Math.max(0, width - strW(val)));
    return (colorFn ? colorFn(val) : val) + pad;
  };

  const wName = Math.max(strW('名字'), ...sessions.map((s) => strW(s.name || '—')));
  const wId = Math.max(strW('会话ID'), ...sessions.map((s) => (s.sessionId || '—').length));
  const wStat = Math.max(strW('状态'), ...sessions.map((s) => strW(s.abnormal ? abnormalLabel(s.abnormalKind) : (s.status ? statusLabel(s.status) : '—'))));
  const wTime = Math.max(strW('最后活动'), ...sessions.map((s) => strW(relTime(s.updatedAt))));

  out(C.bold('  ' + padEnd('名字', wName) + '  ' + padEnd('会话ID', wId) +
    '  ' + padEnd('状态', wStat) + '  ' + padEnd('最后活动', wTime) + '  目录') + '\n');

  for (const s of sessions) {
    const dot = cell(s.alive ? '●' : '○', 1, s.abnormal ? (s.abnormalKind === 'error' ? C.red : C.yellow) : (s.alive ? C.green : C.gray));
    const name = s.name ? cell(s.name, wName) : cell('—', wName, C.dim);
    const id = s.sessionId ? cell(s.sessionId, wId, C.cyan) : cell('—', wId, C.dim);
    const stat = s.abnormal
      ? cell(abnormalLabel(s.abnormalKind), wStat, s.abnormalKind === 'error' ? C.red : C.yellow)
      : s.status ? cell(statusLabel(s.status), wStat, s.status === 'busy' ? C.yellow : null)
        : cell('—', wStat, C.dim);
    const time = cell(relTime(s.updatedAt), wTime, C.dim);
    const cwd = s.cwd || C.dim('—');
    out(dot + ' ' + name + '  ' + id + '  ' + stat + '  ' + time + '  ' + cwd + '\n');
  }
}

/* ================================================================== *
 * 按键解析(raw 模式,stdin 为 utf8 字符串)
 * ================================================================== */

function parseKey(s) {
  switch (s) {
    case '\u0003': return { name: 'ctrl-c' };
    case '\r': case '\n': return { name: 'enter' };
    case '\u001b': return { name: 'escape' };
    case '\u007f': case '\b': return { name: 'backspace' };
    case '\u001b[A': case '\u001bOA': return { name: 'up' };
    case '\u001b[B': case '\u001bOB': return { name: 'down' };
    case '\u001b[C': case '\u001bOC': return { name: 'right' };
    case '\u001b[D': case '\u001bOD': return { name: 'left' };
    case '\u001b[H': case '\u001b[1~': case '\u001bOH': return { name: 'home' };
    case '\u001b[F': case '\u001b[4~': case '\u001bOF': return { name: 'end' };
    case '\u001b[5~': return { name: 'pageup' };
    case '\u001b[6~': return { name: 'pagedown' };
  }
  if (s.length >= 1 && ![...s].some((ch) => ch.codePointAt(0) < 32)) {
    return { name: 'char', char: s };
  }
  return { name: 'unknown', raw: s };
}

// 一次读入可能包含多个按键(粘贴、长按、终端合并字节),拆成独立事件。
function tokenizeKeys(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\u001b') {
      const m = s.slice(i).match(/^\u001b(\[[0-9;]*[A-Za-z~]|O[A-Za-z])/);
      if (m) { keys.push(parseKey(m[0])); i += m[0].length; }
      else { keys.push({ name: 'escape' }); i += 1; }
      continue;
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (cp === 13 || cp === 10) keys.push({ name: 'enter' });
    else if (cp === 127 || cp === 8) keys.push({ name: 'backspace' });
    else if (cp === 3) keys.push({ name: 'ctrl-c' });
    else if (cp < 32) keys.push({ name: 'unknown', raw: ch });
    else keys.push({ name: 'char', char: ch });
    i += ch.length;
  }
  return keys;
}

/* ================================================================== *
 * 交互式界面 (TUI)
 * ================================================================== */

const CHROME_LINES = 5; // 标题 + 副标题 + 列头 + 2 行底部

class App {
  constructor(dir, color) {
    this.dir = dir;
    this.color = color;
    this.C = makeColors(color);
    this.sortMode = 'recent';
    this.selected = 0;
    this.offset = 0;
    this.mode = 'list';       // list | detail | search | resume
    this.message = '';
    this.search = '';
    this.resume = null;       // 接管向导状态: { s, where, step, skipPermissions, name }
    this.resumeAfter = 'list';// 接管完成 / 取消后返回的视图
    this.autoRefresh = true;  // 定时重读会话目录
    this.refreshMs = 2000;
    this.timer = null;
    this._restored = false;
    this.reload();
  }

  /* ---- data ---- */
  reload(keepId) {
    const cur = keepId || (this.view && this.view[this.selected] && this.view[this.selected].sessionId);
    const r = loadSessions(this.dir);
    this.missing = r.missing;
    this.all = r.sessions;
    annotateSessions(this.all, this.dir);
    this.applyView();
    if (cur) {
      const i = this.view.findIndex((s) => s.sessionId === cur);
      if (i >= 0) this.selected = i;
    }
    this.clampSel();
  }

  applyView() {
    let list = sortSessions(this.all, this.sortMode);
    if (this.search) {
      const q = this.search.toLowerCase();
      list = list.filter((s) =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.sessionId || '').toLowerCase().includes(q) ||
        (s.cwd || '').toLowerCase().includes(q) ||
        (s.abnormal && ('异常'.includes(this.search) || abnormalLabel(s.abnormalKind).includes(this.search) || (s.abnormalReason || '').toLowerCase().includes(q))));
    }
    this.view = list;
  }

  clampSel() {
    const n = this.view.length;
    if (n === 0) { this.selected = 0; return; }
    if (this.selected < 0) this.selected = 0;
    if (this.selected >= n) this.selected = n - 1;
  }

  current() { return this.view[this.selected] || null; }
  pageSize() { return Math.max(1, (process.stdout.rows || 24) - CHROME_LINES - 1); }
  move(d) { this.selected += d; this.clampSel(); }

  // 自动刷新:定时重读目录,让状态 / PID / 会话列表保持实时。
  tick() {
    if (!this.autoRefresh || this.mode === 'resume') return;
    this.reload();
    this.render();
  }

  toggleAuto() {
    this.autoRefresh = !this.autoRefresh;
    this.message = this.autoRefresh ? `已开启自动刷新(每 ${this.refreshMs / 1000} 秒)` : '已关闭自动刷新';
  }

  /* ---- actions ---- */
  copyToClipboard(text) {
    try { copyText(text); this.message = '已复制 sessionId 到剪贴板'; }
    catch { this.message = '复制失败(系统没有可用的剪贴板命令)'; }
  }

  // 接管: 在会话目录下打开终端,启动一个新的 Claude 处理卡住的会话。
  // 多步向导: 确认 -> 是否跳过权限 -> 是否命名 -> (输入名字) -> 执行。
  startResume() {
    const s = this.current();
    if (!s || !s.sessionId) { this.message = '当前会话没有 sessionId,无法接管'; return; }
    this.resumeAfter = this.mode;          // 完成 / 取消后返回的视图
    this.resume = {
      s,
      where: s.cwd || '(未知目录)',
      step: 'confirm',                     // confirm | skipPerm | askName | inputName
      skipPermissions: false,
      name: '',
    };
    this.mode = 'resume';
    this.message = '';
  }

  // 接管向导按键: 各 y/N 步骤默认"否",esc 随时取消整个流程。
  keyResume(k) {
    const f = this.resume;
    if (!f) { this.mode = this.resumeAfter || 'list'; return; }
    const c = k.char;
    if (k.name === 'escape') return this.cancelResume();

    switch (f.step) {
      case 'confirm':                      // 仅 y 继续,其它键取消(与原确认行为一致)
        if (c === 'y' || c === 'Y') f.step = 'skipPerm';
        else this.cancelResume();
        break;
      case 'skipPerm':                     // 是否 --dangerously-skip-permissions,默认否
        if (c === 'y' || c === 'Y') { f.skipPermissions = true; f.step = 'askName'; }
        else if (c === 'n' || c === 'N' || k.name === 'enter') { f.skipPermissions = false; f.step = 'askName'; }
        break;
      case 'askName':                      // 是否命名(--name),默认否
        if (c === 'y' || c === 'Y') f.step = 'inputName';
        else if (c === 'n' || c === 'N' || k.name === 'enter') { f.name = ''; this.finishResume(); }
        break;
      case 'inputName':                    // 输入名字,enter 确定(空名字视为不命名)
        if (k.name === 'enter') this.finishResume();
        else if (k.name === 'backspace') f.name = [...f.name].slice(0, -1).join('');
        else if (k.name === 'char') f.name += c.replace(/[\r\n]/g, '');
        break;
    }
  }

  cancelResume() {
    this.mode = this.resumeAfter || 'list';
    this.resume = null;
    this.message = '已取消接管';
  }

  finishResume() {
    const f = this.resume;
    this.mode = this.resumeAfter || 'list';
    this.resume = null;
    if (f) this.launchResume(f.s, { skipPermissions: f.skipPermissions, name: f.name.trim() });
  }

  launchResume(s, opts) {
    opts = opts || {};
    const cwd = s.cwd || process.env.HOME || '.';
    let opened = false;
    try { opened = openTerminalAndRun(cwd, s.sessionId, resumePrompt(s.sessionId), opts); } catch { opened = false; }
    let copied = false;
    try { copied = copyText(humanResumeCommand(s.sessionId, opts)); } catch { copied = false; }
    const extra = [];
    if (opts.skipPermissions) extra.push('跳过权限');
    if (opts.name) extra.push('名字:' + opts.name);
    const suffix = extra.length ? ' [' + extra.join(' · ') + ']' : '';
    this.message = opened
      ? ('已打开终端,启动 Claude 处理会话 ' + s.sessionId.slice(0, 8) + suffix + (copied ? ' (命令已复制)' : ''))
      : (copied ? '打开终端失败,命令已复制到剪贴板,请手动粘贴执行' : '打开终端失败');
  }

  cycleSort() {
    this.sortMode = this.sortMode === 'recent' ? 'name' : this.sortMode === 'name' ? 'cwd' : 'recent';
    const cur = this.current() && this.current().sessionId;
    this.applyView();
    if (cur) { const i = this.view.findIndex((s) => s.sessionId === cur); if (i >= 0) this.selected = i; }
    this.clampSel();
    this.message = '已按' + sortLabel(this.sortMode) + '排序';
  }

  /* ---- input ---- */
  onData(str) {
    for (const k of tokenizeKeys(str)) {
      if (k.name === 'ctrl-c') return this.quit();
      switch (this.mode) {
        case 'list': this.keyList(k); break;
        case 'detail': this.keyDetail(k); break;
        case 'search': this.keySearch(k); break;
        case 'resume': this.keyResume(k); break;
      }
    }
    this.render();
  }

  keyList(k) {
    const c = k.char;
    if (k.name === 'up' || c === 'k') this.move(-1);
    else if (k.name === 'down' || c === 'j') this.move(1);
    else if (k.name === 'pageup') this.move(-this.pageSize());
    else if (k.name === 'pagedown') this.move(this.pageSize());
    else if (k.name === 'home') { this.selected = 0; }
    else if (k.name === 'end') { this.selected = this.view.length - 1; this.clampSel(); }
    else if (k.name === 'enter') { if (this.current()) { this.mode = 'detail'; this.message = ''; } }
    else if (c === '/') { this.mode = 'search'; this.message = ''; }
    else if (c === 's') this.cycleSort();
    else if (c === 'g') { this.reload(); this.message = '已刷新'; }
    else if (c === 'a') this.toggleAuto();
    else if (c === 'o') this.startResume();
    else if (c === 'q' || k.name === 'escape') this.quit();
  }

  keyDetail(k) {
    const c = k.char;
    if (k.name === 'escape' || c === 'q') { this.mode = 'list'; this.message = ''; }
    else if (c === 'y') { const s = this.current(); if (s && s.sessionId) this.copyToClipboard(s.sessionId); }
    else if (c === 'o') this.startResume();
    else if (c === 'g') this.reload();
    else if (c === 'a') this.toggleAuto();
    else if (k.name === 'up' || c === 'k') this.move(-1);
    else if (k.name === 'down' || c === 'j') this.move(1);
  }

  keySearch(k) {
    if (k.name === 'escape') { this.search = ''; this.applyView(); this.selected = 0; this.mode = 'list'; }
    else if (k.name === 'enter') { this.mode = 'list'; }
    else if (k.name === 'backspace') { this.search = [...this.search].slice(0, -1).join(''); this.applyView(); this.selected = 0; }
    else if (k.name === 'char') { this.search += k.char.replace(/[\r\n]/g, ''); this.applyView(); this.selected = 0; }
  }

  /* ---- render ---- */
  render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const C = this.C;
    const lines = [];

    const aliveCount = this.all.filter((s) => s.alive).length;
    const abnCount = this.all.filter((s) => s.abnormal).length;
    const left = ' Claude 会话';
    const right = `共 ${this.view.length} 个 · ${aliveCount} 运行` + (abnCount ? ` · ${abnCount} 异常` : '') + ' ';
    let bar = left + ' '.repeat(Math.max(1, cols - strW(left) - strW(right))) + right;
    lines.push(C.inv(padEnd(truncEnd(bar, cols), cols)));

    const auto = this.autoRefresh ? `自动刷新 ${this.refreshMs / 1000} 秒` : '自动刷新已关';
    let sub = ' ' + this.dir + '   排序: ' + sortLabel(this.sortMode) + '   ' + auto +
      (this.search ? `   过滤: "${this.search}"` : '');
    lines.push(C.dim(truncEnd(sub, cols)));

    if (this.mode === 'detail') this.renderDetail(lines, cols, rows);
    else this.renderList(lines, cols, rows);

    const frame = '\x1b[H\x1b[2J' + lines.map((l) => l + '\x1b[K').join('\r\n');
    process.stdout.write(frame);
  }

  renderList(lines, cols, rows) {
    const C = this.C;
    const listHeight = Math.max(1, rows - CHROME_LINES);

    lines.push(C.dim('    ' + padEnd('名字', 16) + ' ' + padEnd('ID', 8) + ' ' +
      padEnd('状态', 6) + ' ' + padEnd('活动', 10) + ' 目录'));

    if (this.view.length === 0) {
      const msg = this.missing ? '会话目录不存在: ' + this.dir
        : this.search ? '没有匹配过滤条件的会话。' : '当前没有正在运行的会话。';
      for (let i = 0; i < listHeight; i++) lines.push(i === 0 ? '  ' + C.dim(msg) : '');
    } else {
      if (this.selected < this.offset) this.offset = this.selected;
      if (this.selected >= this.offset + listHeight) this.offset = this.selected - listHeight + 1;
      if (this.offset < 0) this.offset = 0;
      for (let r = 0; r < listHeight; r++) {
        const i = this.offset + r;
        if (i >= this.view.length) { lines.push(''); continue; }
        lines.push(this.renderRow(this.view[i], i === this.selected, cols));
      }
    }

    lines.push(this.renderHint(cols));
    lines.push(this.renderMsg(cols));
  }

  renderRow(s, sel, cols) {
    const C = this.C;
    const PREFIX = 4 + 16 + 1 + 8 + 1 + 6 + 1 + 10 + 1; // 箭头+圆点 + 各列 + 分隔
    const cwdW = Math.max(6, cols - PREFIX);
    const segs = [
      { t: sel ? '▶ ' : '  ' },
      { t: (s.alive ? '●' : '○') + ' ', c: s.abnormal ? (s.abnormalKind === 'error' ? C.red : C.yellow) : (s.alive ? C.green : C.gray) },
      { t: s.name || '—', w: 16, c: s.name ? null : C.dim },
      { t: ' ' },
      { t: (s.sessionId || '').slice(0, 8) || '—', w: 8, c: C.cyan },
      { t: ' ' },
      { t: s.abnormal ? abnormalLabel(s.abnormalKind) : (s.status ? statusLabel(s.status) : '—'), w: 6, c: s.abnormal ? (s.abnormalKind === 'error' ? C.red : C.yellow) : (s.status === 'busy' ? C.yellow : (s.status ? null : C.dim)) },
      { t: ' ' },
      { t: relTime(s.updatedAt), w: 10, c: C.dim },
      { t: ' ' },
      { t: s.cwd ? truncStart(s.cwd, cwdW) : '—', c: s.cwd ? null : C.dim },
    ];
    const { raw, colored } = composeRow(segs);
    if (sel) return C.inv(padEnd(truncEnd(raw, cols), cols));
    return colored;
  }

  renderDetail(lines, cols, rows) {
    const C = this.C;
    const s = this.current();
    if (!s) { lines.push(''); lines.push('  ' + C.dim('(未选中会话)')); return; }

    const pidVal = s.pid == null ? '—'
      : s.pid + (s.alive ? C.green('  ● 运行中') : C.gray('  ○ 已退出'));
    const fields = [
      ['名字', s.name || C.dim('(无)')],
      ['会话 ID', s.sessionId || C.dim('—')],
      ['PID', pidVal],
      ['状态', s.status ? statusLabel(s.status) : C.dim('—')],
      ['异常', s.abnormal ? (s.abnormalKind === 'error' ? C.red : C.yellow)(abnormalLabel(s.abnormalKind) + (s.abnormalReason ? ' · ' + s.abnormalReason : '')) : C.dim('无')],
      ['目录', s.cwd ? truncStart(s.cwd, Math.max(10, cols - 16)) : C.dim('—')],
      ['类型', s.kind || C.dim('—')],
      ['版本', s.version || C.dim('—')],
      ['启动时间', fmtDate(s.startedAt)],
      ['更新时间', fmtDate(s.updatedAt) + '  ' + C.dim('(' + relTime(s.updatedAt) + ')')],
      ['文件', truncStart(s.filePath, Math.max(10, cols - 16))],
    ];

    lines.push('');
    for (const [k, v] of fields) lines.push('  ' + C.dim(padEnd(k + ':', 12)) + ' ' + v);
    if (s.parseError) { lines.push(''); lines.push('  ' + C.red('解析错误: ' + s.parseError)); }

    const fill = rows - lines.length - 2;
    for (let i = 0; i < Math.max(0, fill); i++) lines.push('');

    lines.push(C.dim(truncEnd(' o 接管 · y 复制 ID · g 刷新 · ↑↓ 切换 · esc 返回', cols)));
    lines.push(this.renderMsg(cols));
  }

  renderHint(cols) {
    let hint;
    if (this.mode === 'search') hint = '输入文字过滤 · enter 确定 · esc 清除';
    else if (this.mode === 'resume') hint = this.resumeHint();
    else hint = '↑↓/jk 移动 · enter 详情 · o 接管 · a 自动刷新 · g 刷新 · / 过滤 · s 排序 · q 退出';
    return this.C.dim(truncEnd(' ' + hint, cols));
  }

  renderMsg(cols) {
    const C = this.C;
    if (this.mode === 'search') return C.bold(' 过滤: ') + truncEnd(this.search, Math.max(1, cols - 9)) + '▏';
    if (this.mode === 'resume' && this.resume) return this.renderResumeMsg(cols);
    return this.message ? C.green(truncEnd(' ' + this.message, cols)) : '';
  }

  // 接管向导: 底部提示行(随步骤变化)。
  resumeHint() {
    const f = this.resume;
    if (!f) return 'esc 取消';
    switch (f.step) {
      case 'confirm':   return 'y 确认接管 · 其它键取消';
      case 'skipPerm':  return 'y 开启 · n/enter 默认否 · esc 取消';
      case 'askName':   return 'y 命名 · n/enter 默认否 · esc 取消';
      case 'inputName': return '输入名字 · enter 确定 · esc 取消';
    }
    return 'esc 取消';
  }

  // 接管向导: 底部消息行(随步骤显示问题或名字输入框)。
  renderResumeMsg(cols) {
    const C = this.C;
    const f = this.resume;
    const id = (f.s.sessionId || '').slice(0, 8);
    if (f.step === 'inputName') {
      return C.bold(' 会话名字(--name): ') + truncEnd(f.name, Math.max(1, cols - 20)) + '▏';
    }
    let q;
    if (f.step === 'confirm') q = `在 ${f.where} 打开终端,启动 Claude 处理卡住的会话 ${id}?`;
    else if (f.step === 'skipPerm') q = '是否开启 --dangerously-skip-permissions(跳过权限确认)?';
    else q = '是否给新会话命名(--name)?';
    return C.yellow(truncEnd(' ' + q + ' (y/N)', cols));
  }

  /* ---- lifecycle ---- */
  start() {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    process.stdout.write('\x1b[?1049h\x1b[?25l'); // 备用屏 + 隐藏光标

    const cleanup = () => this.cleanup();
    process.on('exit', cleanup);
    process.on('SIGTERM', () => this.quit());
    process.on('uncaughtException', (e) => { this.cleanup(); console.error(e); process.exit(1); });

    stdin.on('data', (d) => this.onData(d));
    process.stdout.on('resize', () => this.render());
    this.timer = setInterval(() => this.tick(), this.refreshMs);
    this.render();
  }

  cleanup() {
    if (this._restored) return;
    this._restored = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { process.stdout.write('\x1b[?25h\x1b[?1049l'); } catch { /* ignore */ }
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }

  quit() { this.cleanup(); process.exit(0); }
}

/* ================================================================== *
 * 命令行
 * ================================================================== */

function help() {
  process.stdout.write(`claude-rescue ${VERSION} — 查看并接管 Claude Code 会话

用法
  claude-rescue               启动交互式界面(在终端里默认如此)
  claude-rescue --list        打印纯文本表格后退出
  claude-rescue --json        输出 JSON 后退出

选项
  -l, --list         非交互的表格输出
      --json         JSON 输出(给脚本用)
      --dir <路径>   指定会话目录
      --no-color     关闭颜色(也遵守 $NO_COLOR)
  -h, --help         显示本帮助
  -v, --version      显示版本

会话目录(自动定位)
  $CLAUDE_CONFIG_DIR/sessions   若设置了 CLAUDE_CONFIG_DIR
  ~/.claude/sessions            否则
  (~ 在 Windows 上是 %USERPROFILE%,在 macOS/Linux 上是 $HOME)
  当前: ${getSessionsDir()}
  注意: 该目录只包含正在运行的会话,退出即清除。

界面快捷键
  ↑/↓ 或 j/k   移动           enter   详情
  PgUp/PgDn    翻页           o       接管(开终端启动新会话,可选跳过权限/命名)
  Home/End     跳到首/末      a       开关自动刷新
  /            过滤           g       立即刷新一次
  s            切换排序       y       (详情页)复制 sessionId
  q / Esc      退出
`);
}

function main() {
  const args = process.argv.slice(2);
  const opts = { json: false, list: false, color: undefined, dir: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { help(); return; }
    else if (a === '--version' || a === '-v') { process.stdout.write('claude-rescue ' + VERSION + '\n'); return; }
    else if (a === '--json') opts.json = true;
    else if (a === '--list' || a === '-l' || a === '--plain') opts.list = true;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--color') opts.color = true;
    else if (a === '--dir') opts.dir = args[++i];
    else if (a.startsWith('--dir=')) opts.dir = a.slice('--dir='.length);
    else { process.stderr.write('未知选项: ' + a + '\n(用 --help 查看帮助)\n'); process.exit(2); }
  }

  const dir = opts.dir ? expandHome(opts.dir) : getSessionsDir();
  const color = opts.color !== undefined ? opts.color : (!!process.stdout.isTTY && !process.env.NO_COLOR);
  const interactive = !opts.json && !opts.list && !!process.stdout.isTTY && !!process.stdin.isTTY;

  if (!interactive) {
    const { sessions, missing } = loadSessions(dir);
    annotateSessions(sessions, dir);
    if (missing && !opts.json) {
      process.stderr.write(`会话目录不存在: ${dir}\n` +
        `(请先运行一次 Claude Code,或设置 CLAUDE_CONFIG_DIR。)\n`);
    }
    printPlain(sortSessions(sessions, 'recent'), { json: opts.json, color, dir });
    return;
  }

  new App(dir, color).start();
}

if (require.main === module) main();

module.exports = {
  VERSION, expandHome, getConfigDir, getSessionsDir, isAlive,
  loadSessions, sortSessions, relTime, sortLabel, statusLabel,
  findTranscript, detectAbnormal, annotateSessions, abnormalLabel,
  resumePrompt, humanResumeCommand, buildResumeCommand,
  parseKey, tokenizeKeys, App,
};
