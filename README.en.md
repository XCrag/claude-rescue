# claude-rescue

[简体中文](README.md) | English

A **zero-dependency** terminal tool that **watches** your running **Claude Code** sessions in real time, flags explicit API retries and errors, and continues the work in a new terminal with one keypress. Behaves identically on **macOS / Windows / Linux**.

Every running Claude Code session writes a small JSON file at `~/.claude/sessions/<pid>.json`. This tool reads that directory and presents an interactive UI (TUI) listing each session's **sessionId, name, directory, status, and last-activity time**, **auto-refreshing every few seconds** so you can see at a glance which sessions are running and which are busy or idle.

> ⚠️ This directory only contains **running** sessions — the moment a session exits, its file is removed. So this tool is a real-time viewer of your **currently active** sessions.
>
> The tool is **read-only**: it only reads session files; it never modifies or deletes anything, so you can safely leave it open all the time.

> ℹ️ The TUI itself is in **Simplified Chinese** (as shown below). The status words and the takeover prompt are Chinese; this README explains them in English.

```
 Claude 会话                                              共 3 个 · 3 个运行中
 /Users/you/.claude/sessions   排序: 最近   自动刷新 2 秒
    名字             ID       状态   活动       目录
▶ ● 对比任务         52348f28 忙碌   2分钟前    /Users/you/mc/agent16
  ● abcdefg          d8480e6a 空闲   7分钟前    /Users/you/mc/anyrouter-tool
  ● guihua12         7242c19f 忙碌   37分钟前   /Users/you/code/wms-framework
 ↑↓/jk 移动 · enter 详情 · a 自动刷新 · g 立即刷新 · / 过滤 · s 排序 · q 退出
```

Column legend: **名字** = name, **ID** = sessionId (first 8 chars), **状态** = status (忙碌 = busy, 空闲 = idle), **活动** = last activity, **目录** = directory. `●` = process still running; `○` = exited (you normally won't see this, since exiting clears the file).

## Why there's no "rename / delete / clean up"

- **Rename**: a session's name is owned by the **running Claude process** (kept in its memory and recorded in the session's transcript). Editing `sessions/<pid>.json` from outside is **immediately overwritten** by the running process. **To rename, use the built-in `/rename <name>` command inside Claude** — that's the only reliable way.
- **Delete / clean up**: this directory only holds running sessions; delete a file and the process soon writes it back. And there are no "exited sessions" to clean up (exiting removes them automatically).

So this tool focuses on one thing — **watching**.

## Requirements

- **Node.js 16+** (check with `node --version`). That's all — **no `npm install`** required.

## Run

```bash
node sessions.js
```

> Tip: run it in a **separate terminal window** (not inside a Claude session), so it can own the terminal display and you can see every active session, including that one.

Or install it as a global `claude-rescue` command (a correct launcher is generated on every OS — a `.cmd` on Windows):

```bash
npm install -g .
claude-rescue
```

## Where it looks for sessions

The sessions directory is located automatically, with identical logic on every OS:

| Condition | Directory |
| --- | --- |
| `CLAUDE_CONFIG_DIR` env var is set | `$CLAUDE_CONFIG_DIR/sessions` |
| Otherwise (default) | `~/.claude/sessions` |

`~` is your home directory — on **Windows** that's **`%USERPROFILE%\.claude\sessions`** (e.g. `C:\Users\you\.claude\sessions`), and on **macOS/Linux** it's **`$HOME/.claude/sessions`**. To point at another directory temporarily, use `--dir <path>`.

## Auto-refresh

- By default it re-reads the directory **every 2 seconds**, keeping the list and statuses live;
- Press **`a`** to toggle auto-refresh, **`g`** to refresh once manually;
- The second header line shows the live state: `自动刷新 2 秒` (auto-refresh: 2s) / `自动刷新已关` (auto-refresh: off).

## Anomaly monitoring

The tool reads the **tail** of each session transcript (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`) and flags a session only when its latest decisive API state is an explicit retry or error:

| State | Color | Criterion | Example detail |
| --- | --- | --- | --- |
| **Retrying** (`重试中`) | Yellow | The latest decisive API state is `system/api_error` | `重试 3/10 · 520` |
| **Error** (`错误`) | Red | The latest decisive API state is an assistant `isApiErrorMessage` record | `524 · Error 524: A timeout occurred` |

- Only these explicit API states count as anomalies; idle time, inactivity, tool execution, and permission waits never trigger alerts.
- A newer normal assistant response immediately clears an earlier retry or error.
- In the filter (`/`), type `异常` (anomaly), `重试` (retry), or `错误` (error) to filter matching sessions.
- `abnormalKind` in `--json` output is limited to `ok`, `retrying`, and `error`.

Results are cached by transcript mtime and size, and only the file tail is read, so large transcripts remain fast.

> Note: detection targets **currently running** sessions (those in `sessions/`). Only explicit API errors or retries are flagged; once a process exits, it is no longer in this list (that is a historical session).

## Continue a session in a new terminal

In the list or detail view, press **`o`** on the selected session to enter a short **takeover wizard**:

1. **Confirm takeover** — `y` to continue, any other key cancels (to avoid mis-presses);
2. **Enable `--dangerously-skip-permissions`?** — **default no**: `n` / `enter` skips, `y` enables;
3. **Name it (`--name`)?** — **default no**: `n` / `enter` skips; pick `y`, type a name, then `enter` to confirm (empty = no name).

After the wizard, the tool will:

- Open a new terminal in the session's **directory** (cwd);
- Run `claude [--dangerously-skip-permissions] [--name <name>] '<instruction>'` — starting a **brand-new** Claude session (**without `--resume`**); the switches you chose are appended after `claude`, before the instruction;
- The instruction is (in Chinese): **「sessionId为xxx的任务需要接续处理，请你查看任务进度现在到哪里了，说明下一步，并继续执行任务。」** — *"The task with sessionId xxx needs to be continued. Check its current progress, explain the next step, and continue the work."* (where `xxx` is the selected session's sessionId).

This way a fresh Claude starts in the same project directory, inspects the selected session's progress, decides the next step, and continues — commonly after an explicit API retry or error. Because the new session starts with an (almost) empty context, its requests are small and don't hit the same rate-limit / timeout loop that kept the old, long-context session retrying.

- Press **`esc`** at any wizard step to cancel the whole flow;
- The command (with your chosen switches) is also **copied to the clipboard**, so if the terminal didn't open you can paste and run it manually;
- If no takeover terminal has been configured yet, the first real takeover asks you to choose one and saves it to `~/.claude-rescue/config.json`.

### Takeover terminal configuration

Terminal selection is explicit. The tool does not auto-guess.

Priority:

1. CLI option: `--terminal <id>`
2. Environment variable: `CLAUDE_RESCUE_TERMINAL=<id>`
3. Config file: `~/.claude-rescue/config.json`
4. If none exists, ask on the first `o` takeover and save the answer

Available terminal ids:

| System | Terminal ids |
| --- | --- |
| macOS | `terminal`, `iterm2`, `custom` |
| Windows | `powershell`, `windows-terminal`, `custom` |
| Linux | `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `wezterm`, `alacritty`, `custom` |

Reconfigure:

```bash
claude-rescue --configure-terminal
```

Temporary override:

```bash
claude-rescue --terminal iterm2
CLAUDE_RESCUE_TERMINAL=wezterm claude-rescue
```

Custom terminal templates are for advanced users. They must include `{command}` and may include `{cwd}`:

```bash
claude-rescue --terminal custom \
  --terminal-command "wezterm start --cwd {cwd} -- bash -lc {command}"
```

Config example:

```json
{
  "terminal": "iterm2"
}
```

Custom template example:

```json
{
  "terminal": "custom",
  "terminalCommand": "kitty --directory {cwd} bash -lc {command}"
}
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `↑` / `↓` or `j` / `k` | Move selection |
| `PgUp` / `PgDn` | Previous / next page |
| `Home` / `End` | Jump to first / last |
| `Enter` | View session detail |
| `o` | Take over: open a terminal in the session's dir and rescue it (see above) |
| `a` | Toggle auto-refresh |
| `g` | Refresh once |
| `y` | (in detail view) copy sessionId to clipboard |
| `/` | Filter by name / sessionId / directory |
| `s` | Cycle sort: recent → name → directory |
| `q` / `Esc` | Quit (in filter mode, `Esc` cancels) |

## Non-interactive usage (scripts / pipes)

When the output isn't a terminal, or you pass arguments, it prints the result and exits instead of opening the UI:

```bash
node sessions.js --list      # aligned plain-text table (Chinese labels)
node sessions.js --json      # JSON array with English field names, for scripts
node sessions.js --json | jq -r '.[] | select(.alive) | .sessionId'
```

### Options

| Option | Description |
| --- | --- |
| `-l`, `--list` | Print a plain-text table, then exit |
| `--json` | Output JSON (for scripts) |
| `--dir <path>` | Use the given sessions directory |
| `--terminal <id>` | Temporarily choose the takeover terminal |
| `--terminal-command <template>` | Custom template used with `--terminal custom` |
| `--configure-terminal` | Reconfigure and save the takeover terminal |
| `--no-color` | Disable color (also respects `$NO_COLOR`) |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## Notes & caveats

- **Liveness detection** uses `process.kill(pid, 0)` — it only probes whether the process exists; it **does not actually signal or kill** it. The OS may reuse PIDs, so in rare cases the judgment can be off; treat it as best-effort.
- **Windows terminal**: color and the full-screen UI need a VT-capable terminal (Windows Terminal, or `conhost` on Windows 10+, which today's default terminals support). On a very old console, use `--list` / `--json` instead.

## Acknowledgements

Shared and discussed on the [LINUX DO](https://linux.do) community — thanks to the folks there for the feedback and for hosting open-source sharing.

本项目在 [LINUX DO](https://linux.do) 社区分享与讨论，感谢社区与各位佬友。

## License

MIT
