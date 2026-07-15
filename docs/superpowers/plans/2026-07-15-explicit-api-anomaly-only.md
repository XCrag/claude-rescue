# Explicit API Anomaly-Only Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove inactivity-based “无响应” alerts so a session is abnormal only while its transcript’s latest decisive API state is an explicit retry or error.

**Architecture:** Keep transcript-tail parsing and its mtime/size cache, but classify records newest-first. `system/api_error` and assistant API-error messages create anomalies; a newer normal assistant record clears them. Session liveness and `updatedAt` remain display data and no longer participate in anomaly classification.

**Tech Stack:** Node.js 16+, CommonJS, built-in `node:test` and `node:assert/strict`, zero runtime dependencies.

## Global Constraints

- Inactivity alone must never create an anomaly.
- Runtime anomaly kinds are exactly `ok`, `retrying`, and `error`; `slow` is removed.
- A newer successful assistant response clears a prior retry or error.
- User messages, tool results, duration records, and metadata neither create nor clear an anomaly.
- Keep terminal selection, session loading, display/sorting data, and launch behavior unchanged.
- Preserve zero runtime dependencies and Node.js `>=16` compatibility.

## File Map

- Create `test/anomaly-detection.test.js`: regression and state-transition coverage for anomaly classification.
- Modify `sessions.js`: remove time-based alerts, implement newest-decisive transcript classification, and neutralize takeover copy that asserts a session is stuck.
- Modify `README.md`: document the two explicit anomaly states in Chinese.
- Modify `README.en.md`: document the two explicit anomaly states in English.
- Modify `linux-do-post.md`: align the long-form product post with explicit API anomaly detection.
- Modify `linux-do-post-short.md`: replace the claim that all stuck sessions are detected.
- Modify `项目介绍-截图用.md`: replace the claim that all stuck sessions are detected.
- Modify `package.json`: update the package description; do not add dependencies.

---

### Task 1: Replace inactivity alerts with explicit API state detection

**Files:**
- Create: `test/anomaly-detection.test.js`
- Modify: `sessions.js:212-308`

**Interfaces:**
- Consumes: `detectAbnormal(file: string)` and `annotateSessions(sessions: object[], sessionsDir: string)` exported by `sessions.js`.
- Produces: anomaly results shaped as `{ kind: 'ok' | 'retrying' | 'error', reason: string | null }` and session fields `abnormalKind`, `abnormal`, `abnormalReason`.

- [ ] **Step 1: Add regression and state-transition tests**

Create `test/anomaly-detection.test.js` with this complete content:

```js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const rescue = require('../sessions.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rescue-anomaly-'));
let transcriptNumber = 0;

after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function writeTranscript(records) {
  const file = path.join(tempRoot, `transcript-${transcriptNumber++}.jsonl`);
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return file;
}

function retryRecord() {
  return {
    type: 'system',
    subtype: 'api_error',
    retryAttempt: 3,
    maxRetries: 10,
    error: { status: 520 },
  };
}

function apiErrorRecord() {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    apiErrorStatus: 524,
    message: {
      content: [{ type: 'text', text: 'API Error: {"title":"A timeout occurred"}' }],
    },
  };
}

function successfulAssistantRecord() {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Recovered successfully.' }],
    },
  };
}

test('an old live session without API evidence remains normal', () => {
  const sessionsDir = path.join(tempRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const session = {
    sessionId: 'idle-session',
    cwd: '/tmp/project',
    alive: true,
    updatedAt: Date.now() - 60 * 60 * 1000,
  };

  rescue.annotateSessions([session], sessionsDir);

  assert.equal(session.abnormal, false);
  assert.equal(session.abnormalKind, 'ok');
  assert.equal(session.abnormalReason, null);
});

test('the latest explicit API retry is abnormal', () => {
  const result = rescue.detectAbnormal(writeTranscript([retryRecord()]));

  assert.deepEqual(result, { kind: 'retrying', reason: '重试 3/10 · 520' });
});

test('the latest explicit assistant API error is abnormal', () => {
  const result = rescue.detectAbnormal(writeTranscript([apiErrorRecord()]));

  assert.deepEqual(result, { kind: 'error', reason: '524 · A timeout occurred' });
});

test('a newer successful assistant response clears an API error', () => {
  const result = rescue.detectAbnormal(writeTranscript([
    apiErrorRecord(),
    successfulAssistantRecord(),
  ]));

  assert.deepEqual(result, { kind: 'ok', reason: null });
});

test('a newer successful assistant response clears an API retry', () => {
  const result = rescue.detectAbnormal(writeTranscript([
    retryRecord(),
    successfulAssistantRecord(),
  ]));

  assert.deepEqual(result, { kind: 'ok', reason: null });
});

test('user and duration records do not clear an API error', () => {
  const result = rescue.detectAbnormal(writeTranscript([
    apiErrorRecord(),
    { type: 'user', message: { role: 'user', content: 'retry please' } },
    { type: 'system', subtype: 'turn_duration', durationMs: 1000 },
  ]));

  assert.deepEqual(result, { kind: 'error', reason: '524 · A timeout occurred' });
});
```

- [ ] **Step 2: Run the new test file and verify the regression tests fail**

Run:

```bash
node --test test/anomaly-detection.test.js
```

Expected: exit code `1`. The tests named `an old live session without API evidence remains normal` and `a newer successful assistant response clears an API error` fail against the old behavior; the failure is assertion output, not a syntax or setup error.

- [ ] **Step 3: Implement newest-decisive anomaly classification**

In `sessions.js`, replace the three-kind comment, `SLOW_MS`, and `abnormalLabel` with:

```js
// 会话异常只保留两种明确的 API 状态:
// 'retrying'(正在 API 重试) / 'error'(已收到 API 错误)。
// 非对话元数据不会创建或清除异常。
const META_TYPES = new Set([
  'mode', 'permission-mode', 'file-history-snapshot', 'attachment',
  'ai-title', 'last-prompt', 'custom-title', 'agent-name',
]);

// kind -> 状态列短标签(<= 3 个汉字,放得进 6 格宽的状态列)。
function abnormalLabel(kind) {
  return kind === 'retrying' ? '重试中'
    : kind === 'error' ? '错误' : '';
}
```

Replace `detectAbnormalUncached` with:

```js
function detectAbnormalUncached(file) {
  let lines;
  try { lines = readTailLines(file, 262144); } catch { return { kind: 'ok', reason: null }; }
  const essential = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || !o.type || META_TYPES.has(o.type)) continue;
    essential.push(o);
  }

  // 从新到旧寻找最近一个能明确 API 状态的记录。
  // user / tool_result / turn_duration 等记录既不创建异常,也不清除异常。
  for (let i = essential.length - 1; i >= 0; i--) {
    const o = essential[i];
    if (o.type === 'system' && o.subtype === 'api_error') {
      return { kind: 'retrying', reason: retryReason(o) };
    }
    if (o.type !== 'assistant') continue;
    if (o.isApiErrorMessage === true) {
      return { kind: 'error', reason: errorReason(o) };
    }
    return { kind: 'ok', reason: null };
  }
  return { kind: 'ok', reason: null };
}
```

Update the annotation comment and function to:

```js
// 给每个会话标注 transcript 路径与当前 API 异常状态:
//   s.abnormalKind   'ok' | 'retrying' | 'error'
//   s.abnormal       兼容旧用法的布尔(= kind !== 'ok')
//   s.abnormalReason 详情文案(重试次数 / 状态码等)
function annotateSessions(sessions, sessionsDir) {
  const projectsDir = path.join(path.dirname(sessionsDir), 'projects');
  for (const s of sessions) {
    s.transcript = findTranscript(s.sessionId, s.cwd, projectsDir);
    const r = s.transcript ? detectAbnormal(s.transcript) : { kind: 'ok', reason: null };
    s.abnormalKind = r.kind;
    s.abnormal = r.kind !== 'ok';
    s.abnormalReason = r.reason || null;
  }
  return sessions;
}
```

Delete the obsolete comment saying `slow` is layered in `annotateSessions`.

- [ ] **Step 4: Run the anomaly tests and verify they pass**

Run:

```bash
node --test test/anomaly-detection.test.js
```

Expected: exit code `0`, `6` tests passed, `0` failed.

- [ ] **Step 5: Run all tests to catch regressions**

Run:

```bash
node --test
```

Expected: exit code `0`; all anomaly-detection and terminal-selection tests pass.

- [ ] **Step 6: Commit the runtime behavior change**

```bash
git add sessions.js test/anomaly-detection.test.js
git commit -m "fix: alert only on explicit API anomalies"
```

---

### Task 2: Align runtime copy and documentation with explicit API anomalies

**Files:**
- Modify: `sessions.js:316,482,831,1176`
- Modify: `README.md:1-102`
- Modify: `README.en.md:1-104`
- Modify: `linux-do-post.md:40-112`
- Modify: `linux-do-post-short.md:1-12`
- Modify: `项目介绍-截图用.md:1-8`
- Modify: `package.json:4`

**Interfaces:**
- Consumes: runtime anomaly kinds `ok`, `retrying`, and `error` from Task 1.
- Produces: neutral takeover prompt text and documentation that advertises only explicit API retry/error detection.

- [ ] **Step 1: Neutralize takeover wording in runtime UI and prompt**

Change `resumePrompt` in `sessions.js` to:

```js
function resumePrompt(sessionId) {
  return `sessionId为${sessionId}的任务需要接续处理，请你查看任务进度现在到哪里了，说明下一步，并继续执行任务。`;
}
```

Change the nearby launch comments from “处理卡住的会话” to “接续处理会话”, and change the resume confirmation to:

```js
if (f.step === 'confirm') q = `在 ${f.where} 打开终端,启动 Claude 接续处理会话 ${id}?`;
```

- [ ] **Step 2: Rewrite the README anomaly sections**

In `README.md`, change the introduction to say the tool marks sessions with explicit API retries or errors. Replace the three-state anomaly section with a two-state table and these rules:

```markdown
本工具还会读取每个会话 **transcript** 的**尾部**（`~/.claude/projects/<编码后的-cwd>/<sessionId>.jsonl`），跳过元数据，只在出现当前仍然成立的明确 API 异常时标记会话：

| 状态 | 颜色 | 判断条件 | 详情示例 |
| --- | --- | --- | --- |
| **重试中** | 黄色 | 最新的明确 API 状态是 `system/api_error` | `重试 3/10 · 520` |
| **错误** | 红色 | 最新的明确 API 状态是 `isApiErrorMessage` 助手消息 | `524 · Error 524: A timeout occurred` |

- 只有这两种明确 API 状态会计入异常数量；空闲、长时间无活动、工具执行或权限等待都不会告警；
- 后续出现正常 assistant 响应时，之前的错误或重试立即清除；
- 在过滤（`/`）中，输入 `异常`、`重试` 或 `错误` 可筛选对应会话；
- `--json` 输出中的 `abnormalKind` 只可能是 `ok`、`retrying` 或 `error`。

判定结果按 transcript 的 mtime 和大小缓存，只读取文件尾部，不会随 transcript 变大而持续变慢。
```

Rename the takeover heading to `## 接续处理一个会话`, update its quoted instruction to the neutral `resumePrompt` text, and describe takeover as a manual action commonly used for API retry/error recovery.

Make the equivalent English changes in `README.en.md` using this anomaly section:

```markdown
The tool reads the **tail** of each session transcript and flags a session only when its latest decisive API state is an explicit retry or error:

| State | Color | Criterion | Example detail |
| --- | --- | --- | --- |
| **Retrying** (`重试中`) | Yellow | The latest decisive API state is `system/api_error` | `重试 3/10 · 520` |
| **Error** (`错误`) | Red | The latest decisive API state is an assistant `isApiErrorMessage` record | `524 · Error 524: A timeout occurred` |

- Only these explicit API states count as anomalies; idle time, inactivity, tool execution, and permission waits never trigger alerts.
- A newer normal assistant response immediately clears an earlier retry or error.
- `abnormalKind` in `--json` output is limited to `ok`, `retrying`, and `error`.
```

Rename the heading to `## Continue a session in a new terminal` and use a neutral English translation of the new `resumePrompt`.

- [ ] **Step 3: Align secondary product copy and package metadata**

In `linux-do-post.md`, remove the “无响应” row and the “最近 3 条” explanation. State that the latest decisive transcript state controls the result, later successful assistant output clears errors, and inactivity never alerts. Remove “无响应” from filter examples.

In `linux-do-post-short.md` and `项目介绍-截图用.md`, replace “把正在跑的会话都列出来，卡住的标个色” with:

```text
把正在跑的会话都列出来，明确出现 API 错误或重试的会话标个色
```

In `package.json`, set:

```json
"description": "Live cross-platform TUI to watch Claude Code sessions, flag explicit API retries and errors, and continue work in a new session. Zero dependencies."
```

- [ ] **Step 4: Verify stale alert claims are gone from runtime and public docs**

Run:

```bash
rg -n "SLOW_MS|kind: 'slow'|无响应|Unresponsive|unresponsive|last 3|最近 3" sessions.js README.md README.en.md linux-do-post.md linux-do-post-short.md 项目介绍-截图用.md package.json
```

Expected: no matches and exit code `1` from `rg` because the searched stale terms are absent.

Run:

```bash
node -e "const p=require('./package.json'); if (/stuck|卡住|unresponsive/i.test(p.description)) process.exit(1)"
```

Expected: exit code `0` with no output.

- [ ] **Step 5: Run all tests after copy changes**

Run:

```bash
node --test
```

Expected: exit code `0`; all tests pass.

- [ ] **Step 6: Commit documentation and copy updates**

```bash
git add sessions.js README.md README.en.md linux-do-post.md linux-do-post-short.md 项目介绍-截图用.md package.json
git commit -m "docs: describe explicit API anomaly alerts"
```

---

### Task 3: Perform final behavioral and repository verification

**Files:**
- Verify only; no planned modifications.

**Interfaces:**
- Consumes: the runtime classifier and public documentation delivered by Tasks 1 and 2.
- Produces: fresh evidence that the requested behavior and repository constraints are satisfied.

- [ ] **Step 1: Run the complete automated test suite**

Run:

```bash
node --test
```

Expected: exit code `0`, all tests pass, no warnings or failures.

- [ ] **Step 2: Exercise non-interactive runtime entry points**

Run:

```bash
node sessions.js --help
node sessions.js --json
```

Expected: both commands exit `0`; help text renders and JSON output parses as an array.

Validate JSON explicitly:

```bash
node sessions.js --json | jq -e 'type == "array" and all(.[]; (.abnormalKind == "ok" or .abnormalKind == "retrying" or .abnormalKind == "error"))'
```

Expected: `true` and exit code `0`.

- [ ] **Step 3: Verify repository hygiene and inspect the final diff**

Run:

```bash
git diff --check HEAD~2..HEAD
git status --short
git log --oneline -4
```

Expected: `git diff --check` has no output; `git status --short` is empty; the log contains the runtime and documentation commits after the design and plan commits.
