# claude-rescue

简体中文 | [English](README.en.md)

一个**零依赖**的终端工具，实时**监视**你正在运行的 **Claude Code** 会话，标记出卡住的那些，并能一键**接管它们进行救援**。在 **macOS / Windows / Linux** 上行为完全一致。

每个正在运行的 Claude Code 会话都会在 `~/.claude/sessions/<pid>.json` 写入一个小的 JSON 文件。本工具读取该目录，以交互式界面（TUI）列出每个会话的 **sessionId、名字、目录、状态和最近活动时间**，并**每隔几秒自动刷新**，让你一眼就能看出哪些会话在运行、哪些忙碌或空闲。

> ⚠️ 该目录只包含**正在运行**的会话——会话一旦退出，其文件就会被移除。所以本工具是你**当前活跃**会话的实时查看器。
>
> 本工具是**只读**的：它只读取会话文件，从不修改或删除任何东西，所以你可以放心一直开着它。

```
 Claude 会话                                              共 3 个 · 3 个运行中
 /Users/you/.claude/sessions   排序: 最近   自动刷新 2 秒
    名字             ID       状态   活动       目录
▶ ● 对比任务         52348f28 忙碌   2分钟前    /Users/you/mc/agent16
  ● abcdefg          d8480e6a 空闲   7分钟前    /Users/you/mc/anyrouter-tool
  ● guihua12         7242c19f 忙碌   37分钟前   /Users/you/code/wms-framework
 ↑↓/jk 移动 · enter 详情 · a 自动刷新 · g 立即刷新 · / 过滤 · s 排序 · q 退出
```

列说明：**名字** = 会话名字，**ID** = sessionId（前 8 位），**状态**（忙碌 / 空闲），**活动** = 最近活动时间，**目录** = 工作目录。`●` = 进程仍在运行；`○` = 已退出（正常情况下你看不到它，因为退出会清除文件）。

## 为什么没有"重命名 / 删除 / 清理"

- **重命名**：会话的名字归**正在运行的 Claude 进程**所有（保存在其内存中，并记录在会话的 transcript 里）。从外部编辑 `sessions/<pid>.json` 会**立即被运行中的进程覆盖**。**要重命名，请在 Claude 内部使用内置的 `/rename <名字>` 命令**——这是唯一可靠的方式。
- **删除 / 清理**：该目录只保存正在运行的会话；删掉一个文件，进程很快会把它写回来。而且也没有"已退出的会话"需要清理（退出会自动移除它们）。

所以本工具专注于一件事——**监视**。

## 环境要求

- **Node.js 16+**（用 `node --version` 查看）。仅此而已——**无需 `npm install`**。

## 运行

```bash
node sessions.js
```

> 提示：在一个**单独的终端窗口**里运行它（不要在 Claude 会话内部运行），这样它能独占终端显示，你也能看到每个活跃会话，包括那一个。

或者把它安装成全局的 `claude-rescue` 命令（每个操作系统都会生成正确的启动器——Windows 上是 `.cmd`）：

```bash
npm install -g .
claude-rescue
```

## 它在哪里查找会话

会话目录会自动定位，在每个操作系统上逻辑一致：

| 条件 | 目录 |
| --- | --- |
| 设置了 `CLAUDE_CONFIG_DIR` 环境变量 | `$CLAUDE_CONFIG_DIR/sessions` |
| 否则（默认） | `~/.claude/sessions` |

`~` 是你的主目录——在 **Windows** 上是 **`%USERPROFILE%\.claude\sessions`**（例如 `C:\Users\you\.claude\sessions`），在 **macOS/Linux** 上是 **`$HOME/.claude/sessions`**。要临时指向另一个目录，用 `--dir <路径>`。

## 自动刷新

- 默认**每 2 秒**重新读取一次目录，保持列表和状态实时更新；
- 按 **`a`** 切换自动刷新，按 **`g`** 手动刷新一次；
- 第二行表头显示实时状态：`自动刷新 2 秒` / `自动刷新已关`。

## 异常监控

本工具还会读取每个会话 **transcript** 的**尾部**（`~/.claude/projects/<编码后的-cwd>/<sessionId>.jsonl`），跳过元数据记录，只看实质性的对话内容，把会话健康度分为三种状态：

| 状态 | 颜色 | 判定标准 | 详情示例 |
| --- | --- | --- | --- |
| **重试中** | 黄色 | 最后一条实质性记录是 API 重试（`system/api_error`）——工具正在自动重试 | `重试 3/10 · 520` |
| **错误** | 红色 | 最后 3 条实质性记录中有一条是 API 错误的 assistant 消息（`isApiErrorMessage`） | `524 · Error 524: A timeout occurred` |
| **无响应** | 黄色 | 进程存活，但会话**超过 5 分钟**没有更新（很可能卡住了，或在等一个非常长的响应） | `无响应 8 分钟` |

- 这三种都会在**状态列**以对应颜色显示（错误 = 红，重试中 / 无响应 = 黄），开头的圆点也会变成相应颜色；
- 标题栏显示异常数量（例如 `· 2 异常`），统计全部三种状态；
- **详情视图**会显示具体原因（状态码、重试次数、无响应时长等）；
- 在过滤（`/`）中，输入 `异常`，或 `重试` / `错误` / `无响应`，可筛选匹配的会话；
- `--json` 输出包含 `abnormal`（布尔）、`abnormalKind`（`ok` / `retrying` / `error` / `slow`）和 `abnormalReason` 字段，方便脚本化监控。

出于性能考虑，它只读取 transcript 的一**小段尾部**："重试 / 错误"按文件 mtime 缓存，而"无响应"则在每次扫描时按时间实时判定。所以即使 transcript 很大也能保持快速。

> 注意：检测针对**当前正在运行**的会话（即 `sessions/` 里的那些）。一个进程仍存活、但出错 / 正在重试 / 卡住的会话会被标记；一旦进程退出，它就不再出现在这个列表里（那属于历史会话）。

## 接管一个卡住的会话

在列表或详情视图中，对选中的会话按 **`o`**，进入一个简短的**接管向导**：

1. **确认接管**——`y` 继续，按其他任意键取消（避免误触）；
2. **是否启用 `--dangerously-skip-permissions`？**——**默认否**：`n` / `enter` 跳过，`y` 启用；
3. **是否命名（`--name`）？**——**默认否**：`n` / `enter` 跳过；选 `y`，输入名字，再按 `enter` 确认（空 = 不命名）。

向导完成后，本工具会：

- 在会话的**目录**（cwd）里打开一个新终端；
- 运行 `claude [--dangerously-skip-permissions] [--name <名字>] '<指令>'`——启动一个**全新的** Claude 会话（**不带 `--resume`**）；你选择的开关会追加在 `claude` 之后、指令之前；
- 指令是：**「sessionId为xxx的任务卡住了，你帮我看看任务进度现在到哪里了，下一步我该做什么，请你继续执行任务。」**（其中 `xxx` 是卡住会话的 sessionId）。

这样一个全新的 Claude 会在同一个项目目录里启动，被告知哪个 sessionId 卡住了，然后去检查那个会话的进度、决定下一步并继续执行——通常用来救援一个被标记为异常的会话。由于新会话以（几乎）空的上下文开始，它的请求很小，不会陷入让旧的、长上下文会话不断重试的那种限流 / 超时循环。

- 在向导的任何一步按 **`esc`** 都可取消整个流程；
- 命令（连同你选择的开关）也会**复制到剪贴板**，万一终端没打开，你可以手动粘贴运行；
- 如果还没有配置过接管终端，第一次真正接管时会询问并保存到 `~/.claude-rescue/config.json`。

### 接管终端配置

终端选择遵循明确优先级，不做自动猜测：

1. 命令行参数：`--terminal <id>`
2. 环境变量：`CLAUDE_RESCUE_TERMINAL=<id>`
3. 配置文件：`~/.claude-rescue/config.json`
4. 如果都没有，在第一次按 `o` 接管时询问并保存

可用终端：

| 系统 | 终端 id |
| --- | --- |
| macOS | `terminal`, `iterm2`, `custom` |
| Windows | `powershell`, `windows-terminal`, `custom` |
| Linux | `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `wezterm`, `alacritty`, `custom` |

重新选择：

```bash
claude-rescue --configure-terminal
```

临时覆盖：

```bash
claude-rescue --terminal iterm2
CLAUDE_RESCUE_TERMINAL=wezterm claude-rescue
```

自定义终端模板适合高级用户，必须包含 `{command}`，可选 `{cwd}`：

```bash
claude-rescue --terminal custom \
  --terminal-command "wezterm start --cwd {cwd} -- bash -lc {command}"
```

配置文件示例：

```json
{
  "terminal": "iterm2"
}
```

自定义模板示例：

```json
{
  "terminal": "custom",
  "terminalCommand": "kitty --directory {cwd} bash -lc {command}"
}
```

## 键盘快捷键

| 键 | 操作 |
| --- | --- |
| `↑` / `↓` 或 `j` / `k` | 移动选择 |
| `PgUp` / `PgDn` | 上一页 / 下一页 |
| `Home` / `End` | 跳到第一个 / 最后一个 |
| `Enter` | 查看会话详情 |
| `o` | 接管：在会话目录里打开终端并救援它（见上文） |
| `a` | 切换自动刷新 |
| `g` | 刷新一次 |
| `y` | （在详情视图）复制 sessionId 到剪贴板 |
| `/` | 按名字 / sessionId / 目录过滤 |
| `s` | 循环排序：最近 → 名字 → 目录 |
| `q` / `Esc` | 退出（过滤模式下，`Esc` 取消） |

## 非交互式用法（脚本 / 管道）

当输出不是终端，或你传入参数时，它会打印结果并退出，而不是打开 UI：

```bash
node sessions.js --list      # 对齐的纯文本表格（中文标签）
node sessions.js --json      # JSON 数组，英文字段名，供脚本使用
node sessions.js --json | jq -r '.[] | select(.alive) | .sessionId'
```

### 选项

| 选项 | 说明 |
| --- | --- |
| `-l`, `--list` | 打印纯文本表格，然后退出 |
| `--json` | 输出 JSON（供脚本使用） |
| `--dir <路径>` | 使用指定的会话目录 |
| `--terminal <id>` | 临时指定接管时使用的终端 |
| `--terminal-command <模板>` | `--terminal custom` 时使用的自定义模板 |
| `--configure-terminal` | 重新选择并保存接管终端 |
| `--no-color` | 禁用颜色（也遵循 `$NO_COLOR`） |
| `-h`, `--help` | 显示帮助 |
| `-v`, `--version` | 显示版本 |

## 注意事项与说明

- **存活检测**使用 `process.kill(pid, 0)`——它只探测进程是否存在；**并不真的发送信号或杀死**它。操作系统可能复用 PID，所以极少数情况下判断会出错；请把它当作尽力而为的结果。
- **Windows 终端**：颜色和全屏 UI 需要一个支持 VT 的终端（Windows Terminal，或 Windows 10+ 上的 `conhost`，如今的默认终端都支持）。在非常老的控制台上，请改用 `--list` / `--json`。

## 致谢

本项目在 [LINUX DO](https://linux.do) 社区分享与讨论，感谢社区与各位佬友。

## 许可证

MIT
