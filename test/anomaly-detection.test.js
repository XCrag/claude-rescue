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
