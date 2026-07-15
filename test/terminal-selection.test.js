'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const rescue = require('../sessions.js');

test('parseArgs accepts terminal options without forcing non-interactive list output', () => {
  const opts = rescue.parseArgs(['--terminal', 'iterm2', '--terminal-command', 'wezterm start --cwd {cwd} -- bash -lc {command}']);

  assert.equal(opts.terminal, 'iterm2');
  assert.equal(opts.terminalCommand, 'wezterm start --cwd {cwd} -- bash -lc {command}');
  assert.equal(opts.list, false);
  assert.equal(opts.json, false);
});

test('terminal resolution prefers cli over env over saved config', () => {
  const resolved = rescue.resolveTerminalConfig({
    cli: { terminal: 'terminal' },
    env: { CLAUDE_RESCUE_TERMINAL: 'iterm2' },
    fileConfig: { terminal: 'custom', terminalCommand: 'kitty --directory {cwd} bash -lc {command}' },
    platform: 'darwin',
  });

  assert.deepEqual(resolved, { terminal: 'terminal', terminalCommand: null, source: 'cli' });
});

test('custom terminal requires command template with command placeholder', () => {
  assert.throws(() => rescue.normalizeTerminalConfig({
    terminal: 'custom',
    terminalCommand: 'wezterm start --cwd {cwd}',
    platform: 'linux',
  }), /must include \{command\}/);
});

test('macOS iterm2 command uses iTerm2 AppleScript', () => {
  const built = rescue.buildResumeCommand('darwin', '/tmp/my project', 'abc123', '继续', { terminal: 'iterm2' });

  assert.equal(built.cmd, 'osascript');
  assert.deepEqual(built.args.slice(0, 2), ['-e', built.args[1]]);
  assert.match(built.args[1], /tell application "iTerm2"/);
  assert.match(built.args[1], /create window with default profile/);
  assert.match(built.args[1], /write text/);
  assert.ok(built.args[1].includes("cd '/tmp/my project' && claude '继续'"));
});

test('Windows Terminal command launches wt with PowerShell command', () => {
  const built = rescue.buildResumeCommand('win32', 'C:\\Users\\edy\\proj', 'abc123', '继续', { terminal: 'windows-terminal' });

  assert.equal(built.cmd, 'wt');
  assert.deepEqual(built.args.slice(0, 4), ['new-tab', 'powershell', '-NoExit', '-Command']);
  assert.match(built.args[4], /Set-Location -LiteralPath 'C:\\Users\\edy\\proj'/);
  assert.match(built.args[4], /claude '继续'/);
});

test('Windows default terminal uses start with empty title', () => {
  const built = rescue.buildResumeCommand('win32', 'C:\\Users\\edy\\proj', 'abc123', '继续', {});

  assert.equal(built.cmd, 'cmd');
  assert.deepEqual(built.args.slice(0, 3), ['/c', 'start', '']);
  assert.equal(built.args[3], 'powershell');
});

test('Linux kitty command uses directory and bash login command', () => {
  const built = rescue.buildResumeCommand('linux', '/work/proj', 'abc123', '继续', { terminal: 'kitty' });

  assert.equal(built.cmd, 'kitty');
  assert.deepEqual(built.args, ['--directory', '/work/proj', 'bash', '-lc', "claude '继续'; exec $SHELL"]);
});

test('custom command template is parsed with escaped cwd and command tokens', () => {
  const built = rescue.buildResumeCommand('linux', '/work/my proj', 'abc123', '继续', {
    terminal: 'custom',
    terminalCommand: 'wezterm start --cwd {cwd} -- bash -lc {command}',
  });

  assert.equal(built.cmd, 'wezterm');
  assert.deepEqual(built.args, ['start', '--cwd', '/work/my proj', '--', 'bash', '-lc', "claude '继续'"]);
});
