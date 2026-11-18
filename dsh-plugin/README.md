# dsh-codex-pet-bridge

把 **DSH（DeepSeek Harness）** 的任务执行进度转发给 **Codex Pet** 桌宠的 dsh host 插件。

装上之后，桌宠能跟着 dsh 的回合走：思考 → 执行命令 / 编辑文件 → 等你选择 → 完成 / 失败，
和它监听 Codex、Claude Code、Grok Build 时的表现完全一致。

零运行时依赖、零构建，纯 host 端只读插件。

## 它做了什么

订阅 dsh 的宿主事件，把进度翻译成 Codex Pet 已有的「Hook 收件箱」事件文件：

```
DSH (host)                                   ~/.codex-pet/agent-events/*.json
  agent/status   ─┐                                     ▲
  session/event  ─┼─ dsh-codex-pet-bridge ──────────────┘   Codex Pet 每 500ms 消费一次
  agent/disposed ─┘        （同目录原子 rename 写入）             → 宠物状态机 → 动效 / 气泡
```

不写网络请求、不改 dsh 会话数据；单条事件处理失败只写日志，不影响 dsh 运行。

## 安装

**方式一（推荐）：在 Codex Pet 设置页点「启用 DSH」** —— 桌宠会把本插件写入
`<dsh profile>/node_modules/dsh-codex-pet-bridge`，并在 profile 的 `cordis.patch.yml`
追加一段标记为 `managed block` 的注册块。**改完需要重启 dsh 才会加载。**

**方式二：手动注册**

```powershell
# 1. 把本目录拷到 profile 的 node_modules 下
Copy-Item -Recurse .\dsh-plugin "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-codex-pet-bridge"

# 2. 在 profile 的 cordis.patch.yml 追加
#   - insert:
#       - id: dsh-codex-pet-bridge
#         name: dsh-codex-pet-bridge

# 3. 重启 dsh
```

也可以走官方插件命令（前提是包已在 profile 依赖里登记）：

```powershell
dsh plugin --profile desktop add dsh-codex-pet-bridge
```

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-codex-pet-bridge
  name: dsh-codex-pet-bridge
  config:
    rootsOnly: true
    includeToolNames: true
    summaryMaxChars: 40
```

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `inboxDir` | `~/.codex-pet/agent-events` | 收件箱目录；只有 Codex Pet 设置了 `CODEX_PET_HOOK_INBOX` 时才需要同步 |
| `rootsOnly` | `true` | 仅根会话上报，子代理不刷屏 |
| `summaryMaxChars` | `40` | 气泡里任务摘要的截断长度 |
| `includeToolNames` | `true` | 是否把工具名写进文案（`DSH 正在执行命令：pwsh`） |
| `compactionEventNames` | `{ start: 'compaction/start', end: 'compaction/end' }` | 上下文压缩事件名；dsh 侧事件名以实际版本为准，对不上就不触发 |

## 事件映射

| dsh 事件 | 上报的 Hook 事件 | 宠物状态 |
|---|---|---|
| `agent/status` → running（首次） | `SessionStart` | idle |
| `turn/start` | `UserPromptSubmit` | thinking |
| `user/message` | `UserPromptSubmit`（带任务摘要） | thinking |
| `tool/call` · `pwsh` / `bash` / `terminal` | `PreToolUse` | running_command |
| `tool/call` · `write` / `edit` / `str_replace_editor` … | `PreToolUse` | editing_file |
| `tool/call` · `ask_user_question` | `PermissionRequest` | waiting_input |
| `tool/call` · 其他 | `PreToolUse` | working |
| `tool/result`（含回答完提问） | `PostToolUse` / `Notification` | thinking |
| `turn/end` · `completed` | `Stop` | success |
| `turn/end` · `aborted` | `Stop`（覆盖为 idle） | idle |
| `turn/end` · `error` / `interrupted` / `max-tokens` | `StopFailure` | error |
| 上下文压缩 | `PreCompact` / `PostCompact` | sweeping / thinking |
| `agent/disposed` | `SessionEnd` | 移除会话 |

## 收件箱协议（v2）

一条事件一个文件，文件名 `<receivedAt:16hex>-<pid:8hex>-<seq:16hex>.json`，
同目录临时文件 + `rename` 原子落盘。字段：

```json
{
  "schemaVersion": 2,
  "provider": "dsh",
  "eventName": "PreToolUse",
  "sessionId": "…",
  "cwd": "D:\\A_STUDY\\codex-pet",
  "toolName": "pwsh",
  "message": "DSH 正在执行命令：pwsh",
  "state": "running_command",
  "receivedAt": 1763500000000
}
```

`message` / `state` 是 v2 新增的**可选覆盖**：给了就以它为准，没给则由 Codex Pet 按
`eventName` 的默认文案兜底。`state` 只认宠物状态机的取值（`idle` / `thinking` /
`working` / `running_command` / `editing_file` / `waiting_input` / `sweeping` /
`success` / `error`），非法取值会被忽略并退回默认映射。

## 自测

```powershell
node dsh-plugin/scripts/test-harness.mjs
```

用 mock ctx 直接驱动全部处理器，断言收件箱里写出的每条事件与上表一致，不需要装 dsh。

## 已知边界

- `agent/status` / `session/event` 是 dsh 的 **host 端 Cordis 事件，不是公开稳定 API**。
  本插件对所有字段做防御式读取，取不到就跳过该条事件；dsh 升级后若事件改名，
  升级这里即可，不影响 Codex Pet。
- 上下文压缩的事件名未在实机上核对，默认值对不上时不会产生任何副作用。
- Codex Pet 未运行时事件会堆在收件箱，宠物启动后按 `receivedAt` 判断过期
  （10 分钟）直接丢弃，不会补放历史动画。
- **安装位置是 `node_modules`**：在同一个 profile 里跑 `dsh plugin add` / `pnpm install`
  等包操作时，pnpm 可能把这个未登记在依赖里的目录清掉。届时在 Codex Pet 设置页
  再点一次「启用 DSH」即可恢复。若 dsh 因找不到插件而启动异常，手动删掉 profile
  `cordis.patch.yml` 里 `# >>> codex-pet DSH bridge ... >>>` 到 `# <<< ... <<<`
  之间的托管块即可回到干净状态。
