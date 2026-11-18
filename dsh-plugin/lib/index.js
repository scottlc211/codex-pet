/**
 * dsh-codex-pet-bridge — 把 DSH（DeepSeek Harness）的 agent 运行进度转发给 Codex Pet。
 *
 * 这是一个纯 host 端的 Cordis 插件：只读 dsh 的运行时事件，不发网络请求，
 * 不修改 dsh 的会话数据，任何一条事件处理失败都只记日志、绝不向上抛。
 *
 * 数据通路：本插件把事件写成 Codex Pet 已有的「Hook 收件箱」文件
 * （默认 `~/.codex-pet/agent-events/<ts>-<pid>-<seq>.json`），Codex Pet 侧
 * 的 agent_monitor 每 500ms 扫一次、消费后删除。协议与 Claude Code / Grok
 * 完全一致，只是 `provider` 取值为 `dsh`。
 *
 * 订阅的宿主事件（与 dsh 内部 `agent/status`、`session/event` 契约一致）：
 *   - `agent/status`    { agent, status: 'running' | 'idle' }
 *   - `session/event`   (session, { type, data })
 *        turn/start、user/message、tool/call、tool/result、turn/end
 *   - `agent/disposed`  { agent }
 *
 * @module dsh-codex-pet-bridge
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-codex-pet-bridge'
export const inject = []

/**
 * Hook 收件箱协议版本。
 * v1 只有事件骨架字段（Codex Pet 旧版本写入的版本）；
 * v2 额外允许 `message` / `state` 覆盖，让桥接方给出比「回合完成」更精确的文案。
 */
const HOOK_SCHEMA_VERSION = 2

/** 与 Codex Pet 侧 `agent_monitor.rs` 的字段上限保持一致，避免超长字段被丢弃。 */
const LIMITS = {
  sessionId: 256,
  agentField: 256,
  cwd: 4096,
  message: 1024,
}

/** 默认配置；profile 的 `cordis.patch.yml` 里按 id 覆盖同名字段即可。 */
const DEFAULT_CONFIG = {
  /** 总开关。 */
  enabled: true,
  /**
   * 收件箱目录；留空用 `~/.codex-pet/agent-events`（与 Codex Pet 默认值一致）。
   * 只有 Codex Pet 设置了 `CODEX_PET_HOOK_INBOX` 时才需要在这里同步。
   */
  inboxDir: undefined,
  /** 仅根会话（用户自己的会话）上报，子代理默认不刷屏。 */
  rootsOnly: true,
  /** 用户指令摘要的截断长度（字符）。 */
  summaryMaxChars: 40,
  /** 是否把工具名写进气泡文案。 */
  includeToolNames: true,
  /**
   * 上下文压缩事件名。dsh 的压缩插件事件名以实际版本为准，
   * 这里做成可配置：取值对不上时就自然不触发，不影响其它进度。
   */
  compactionEventNames: { start: 'compaction/start', end: 'compaction/end' },
}

/**
 * 工具名 → Codex Pet 状态的映射。
 * `label` 用于拼气泡文案（「DSH 正在编辑文件」），`state` 是宠物状态机认识的状态。
 */
const TOOL_RULES = [
  {
    pattern: /^(pwsh|bash|terminal|shell)(_persistent)?$/i,
    state: 'running_command',
    label: '执行命令',
  },
  {
    pattern: /^(write|edit|multi_edit|str_replace_editor|edit_file|write_file|notebook_edit)$/i,
    state: 'editing_file',
    label: '编辑文件',
  },
  {
    pattern: /^ask_user_question$/i,
    state: 'waiting_input',
    label: '等待你的选择',
  },
]

function normalizeConfig(config) {
  const cfg = { ...DEFAULT_CONFIG }
  if (config && typeof config === 'object') Object.assign(cfg, config)
  cfg.summaryMaxChars = Math.max(1, Math.floor(Number(cfg.summaryMaxChars) || 40))
  cfg.includeToolNames = cfg.includeToolNames !== false
  cfg.rootsOnly = cfg.rootsOnly !== false
  cfg.compactionEventNames = {
    ...DEFAULT_CONFIG.compactionEventNames,
    ...(config?.compactionEventNames ?? {}),
  }
  return cfg
}

/** 去掉控制字符并截断，防止把终端转义序列写进收件箱。 */
function bound(value, limit) {
  if (typeof value !== 'string') return ''
  let result = ''
  for (const character of value) {
    if (result.length >= limit) break
    if (character === '\n' || character === '\t' || !isControl(character)) result += character
  }
  return result.trim()
}

function isControl(character) {
  const code = character.codePointAt(0) ?? 0
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f
}

/** 固定宽度十六进制，保证收件箱文件名按时间字典序排列。 */
function hex(value, width) {
  return Math.max(0, Math.trunc(Number(value) || 0))
    .toString(16)
    .padStart(width, '0')
    .slice(-width)
}

/**
 * 收件箱写入器：同目录先写临时文件再 rename，读侧永远看不到半截 JSON。
 * Codex Pet 消费后自己删文件，这里不需要清理。
 */
function createInbox(cfg) {
  const dir = cfg.inboxDir || join(homedir(), '.codex-pet', 'agent-events')
  let sequence = 0

  return {
    dir,
    write(payload) {
      mkdirSync(dir, { recursive: true })
      const receivedAt = Date.now()
      sequence += 1
      const fileName = `${hex(receivedAt, 16)}-${hex(process.pid, 8)}-${hex(sequence, 16)}.json`
      const target = join(dir, fileName)
      const temp = join(dir, `${fileName}.tmp`)
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8')
      renameSync(temp, target)
    },
  }
}

/** 从 user/message 里取第一段文本作为任务摘要。 */
function summarizePrompt(message, maxChars) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return bound(block.text.replace(/\s+/g, ' '), maxChars)
    }
  }
  return ''
}

/** 从 ask_user_question 的原始 arguments JSON 里取第一个问题文本。 */
function extractQuestion(rawArguments) {
  try {
    const parsed = JSON.parse(rawArguments)
    const question = Array.isArray(parsed?.questions)
      ? parsed.questions.find((item) => typeof item?.question === 'string' && item.question)
      : null
    return question ? bound(question.question, 60) : ''
  } catch {
    return ''
  }
}

function describeTool(toolName) {
  for (const rule of TOOL_RULES) {
    if (rule.pattern.test(toolName)) return { state: rule.state, label: rule.label }
  }
  return { state: 'working', label: '处理任务' }
}

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) return

  const inbox = createInbox(cfg)
  /** sessionId → 会话级状态；dsh 关闭会话时清理。 */
  const sessions = new Map()

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = { announced: false, turnOpen: false, waitingCallId: null }
      sessions.set(sessionId, state)
    }
    return state
  }

  const warn = (scope, error) => {
    try {
      ctx.logger?.warn?.(`dsh-codex-pet-bridge: ${scope} 处理失败：${String(error)}`)
    } catch {
      // 日志器不可用时也不能影响 dsh。
    }
  }

  const isTracked = (session) => {
    if (!cfg.rootsOnly) return true
    const depth = session?.header?.delegationDepth
    return depth == null || depth === 0
  }

  /** 组装一条 Hook 事件并落盘；字段全部走上限裁剪。 */
  const emit = (session, detail) => {
    const sessionId = bound(session?.id, LIMITS.sessionId)
    if (!sessionId) return
    const cwd = bound(session?.header?.cwd, LIMITS.cwd)
    inbox.write({
      schemaVersion: HOOK_SCHEMA_VERSION,
      provider: 'dsh',
      eventName: detail.eventName,
      sessionId,
      agentId: detail.agentId ? bound(detail.agentId, LIMITS.agentField) : null,
      agentType: null,
      cwd: cwd || null,
      toolName: detail.toolName ? bound(detail.toolName, LIMITS.agentField) : null,
      notificationType: null,
      message: bound(detail.message, LIMITS.message),
      state: detail.state ?? null,
      receivedAt: Date.now(),
    })
  }

  const onStatus = ({ agent, status } = {}) => {
    try {
      const session = agent?.session
      if (!session || !isTracked(session)) return
      const state = stateFor(session.id)

      if (status === 'running') {
        state.turnOpen = true
        if (!state.announced) {
          state.announced = true
          emit(session, {
            eventName: 'SessionStart',
            state: 'idle',
            message: 'DSH 会话已连接',
          })
        }
        return
      }

      // running → idle：正常回合由 turn/end 收尾，这里只兜底没有 turn/end 的中断。
      if (!state.turnOpen) return
      state.turnOpen = false
      emit(session, { eventName: 'Stop', state: 'success', message: 'DSH 回合完成' })
    } catch (error) {
      warn('agent/status', error)
    }
  }

  const onSessionEvent = (session, event) => {
    try {
      if (!session || !isTracked(session)) return
      const state = stateFor(session.id)
      const type = event?.type
      const data = event?.data

      switch (type) {
        case 'turn/start': {
          state.turnOpen = true
          emit(session, {
            eventName: 'UserPromptSubmit',
            state: 'thinking',
            message: 'DSH 正在思考',
          })
          return
        }
        case 'user/message': {
          const prompt = summarizePrompt(data?.message, cfg.summaryMaxChars)
          emit(session, {
            eventName: 'UserPromptSubmit',
            state: 'thinking',
            message: prompt ? `DSH 正在思考「${prompt}」` : 'DSH 正在思考',
          })
          return
        }
        case 'tool/call': {
          const toolName = typeof data?.name === 'string' && data.name ? data.name : 'tool'
          const described = describeTool(toolName)
          if (described.state === 'waiting_input') {
            state.waitingCallId = data?.callId ?? null
            const question = extractQuestion(data?.arguments)
            emit(session, {
              eventName: 'PermissionRequest',
              state: 'waiting_input',
              toolName,
              message: question ? `DSH 等待你确认：${question}` : 'DSH 等待你的选择',
            })
            return
          }
          emit(session, {
            eventName: 'PreToolUse',
            state: described.state,
            toolName,
            message: cfg.includeToolNames
              ? `DSH 正在${described.label}：${toolName}`
              : `DSH 正在${described.label}`,
          })
          return
        }
        case 'tool/result': {
          const callId = data?.message?.callId
          if (state.waitingCallId && callId === state.waitingCallId) {
            state.waitingCallId = null
            emit(session, {
              eventName: 'Notification',
              state: 'thinking',
              message: 'DSH 已收到你的选择，继续处理',
            })
            return
          }
          emit(session, {
            eventName: 'PostToolUse',
            state: 'thinking',
            message: 'DSH 工具执行完成',
          })
          return
        }
        case 'turn/end': {
          state.turnOpen = false
          const reason = data?.reason?.kind ?? 'completed'
          if (reason === 'completed') {
            emit(session, { eventName: 'Stop', state: 'success', message: 'DSH 回合完成' })
          } else if (reason === 'aborted') {
            // 用户主动停止：宠物回到空闲，而不是报错。
            emit(session, { eventName: 'Stop', state: 'idle', message: 'DSH 回合已中止' })
          } else {
            emit(session, {
              eventName: 'StopFailure',
              state: 'error',
              message: `DSH 回合失败（${reason}）`,
            })
          }
          return
        }
        default: {
          if (type === cfg.compactionEventNames.start) {
            emit(session, {
              eventName: 'PreCompact',
              state: 'sweeping',
              message: 'DSH 正在压缩上下文',
            })
          } else if (type === cfg.compactionEventNames.end) {
            emit(session, {
              eventName: 'PostCompact',
              state: 'thinking',
              message: 'DSH 上下文压缩完成',
            })
          }
        }
      }
    } catch (error) {
      warn('session/event', error)
    }
  }

  const onDisposed = ({ agent } = {}) => {
    try {
      const session = agent?.session
      if (!session?.id) return
      sessions.delete(session.id)
      if (!isTracked(session)) return
      emit(session, { eventName: 'SessionEnd', state: 'idle', message: 'DSH 会话已关闭' })
    } catch (error) {
      warn('agent/disposed', error)
    }
  }

  const disposers = [
    ctx.on('agent/status', onStatus),
    ctx.on('session/event', onSessionEvent),
    ctx.on('agent/disposed', onDisposed),
  ]

  ctx.effect(() => async () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 卸载阶段的异常同样不能影响 dsh 退出流程。
      }
    }
    sessions.clear()
  })

  try {
    ctx.logger?.debug?.(`dsh-codex-pet-bridge: 已开始上报，收件箱 ${inbox.dir}`)
  } catch {
    // 忽略日志异常。
  }
}
