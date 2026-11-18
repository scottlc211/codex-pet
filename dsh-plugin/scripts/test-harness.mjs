/**
 * test-harness.mjs — dsh-codex-pet-bridge 自测（不需要 dsh、不需要重启）。
 *
 * 用一个记录事件的 mock ctx 直接驱动插件处理器，把 dsh 侧事件契约
 * （agent/status、session/event、agent/disposed）喂进去，然后断言写到
 * 临时收件箱里的 JSON 与 Codex Pet 期望的 Hook 事件一致。
 *
 * 运行：node scripts/test-harness.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const inbox = mkdtempSync(join(tmpdir(), 'codex-pet-bridge-'))
const handlers = new Map()
let cleanup = null

const ctx = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, [])
    handlers.get(event).push(handler)
    return () => {
      const list = handlers.get(event) ?? []
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  },
  effect(factory) {
    cleanup = factory()
    return () => {}
  },
  logger: {
    debug: () => {},
    info: () => {},
    warn: (message) => console.log(`[warn] ${message}`),
  },
}

plugin.apply(ctx, { inboxDir: inbox, summaryMaxChars: 20 })

const emit = (event, ...args) => {
  for (const handler of handlers.get(event) ?? []) handler(...args)
}

/** 读取并清空收件箱：返回按文件名（即时间序）排列的载荷。 */
function drain() {
  const files = readdirSync(inbox)
    .filter((file) => file.endsWith('.json'))
    .sort()
  const payloads = files.map((file) => JSON.parse(readFileSync(join(inbox, file), 'utf8')))
  for (const file of files) rmSync(join(inbox, file))
  const leftovers = readdirSync(inbox).filter((file) => file.endsWith('.tmp'))
  assert.equal(leftovers.length, 0, '收件箱不应残留 .tmp 文件')
  return payloads
}

function expectEvent(payload, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(
      payload[key],
      value,
      `字段 ${key} 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(payload[key])}`,
    )
  }
}

const rootSession = {
  id: 'session-root',
  header: { cwd: 'D:\\A_STUDY\\codex-pet' },
}
const agent = { id: 'session-root', status: 'running', session: rootSession }

let passed = 0
async function scenario(title, run) {
  await run()
  passed += 1
  console.log(`ok ${passed} - ${title}`)
}

await scenario('会话首次进入 running 时只上报一次 SessionStart', () => {
  emit('agent/status', { agent, status: 'running' })
  emit('agent/status', { agent, status: 'running' })
  const payloads = drain()
  assert.equal(payloads.length, 1)
  expectEvent(payloads[0], {
    schemaVersion: 2,
    provider: 'dsh',
    eventName: 'SessionStart',
    sessionId: 'session-root',
    cwd: 'D:\\A_STUDY\\codex-pet',
    state: 'idle',
  })
})

await scenario('turn/start 与 user/message 映射为思考状态并带任务摘要', () => {
  emit('session/event', rootSession, { type: 'turn/start', data: { turn: 1 } })
  emit('session/event', rootSession, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '把 DSH 接进桌宠，顺便跑一遍测试' }] } },
  })
  const payloads = drain()
  assert.equal(payloads.length, 2)
  expectEvent(payloads[0], { eventName: 'UserPromptSubmit', state: 'thinking' })
  expectEvent(payloads[1], {
    eventName: 'UserPromptSubmit',
    state: 'thinking',
    message: 'DSH 正在思考「把 DSH 接进桌宠，顺便跑一遍测试」',
  })
})

await scenario('超长任务摘要按 summaryMaxChars 截断', () => {
  emit('session/event', rootSession, {
    type: 'user/message',
    data: { message: { content: [{ type: 'text', text: '一'.repeat(64) }] } },
  })
  const payloads = drain()
  assert.equal(payloads[0].message, `DSH 正在思考「${'一'.repeat(20)}」`)
})

await scenario('终端工具映射为 running_command', () => {
  emit('session/event', rootSession, {
    type: 'tool/call',
    data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"pnpm test"}' },
  })
  expectEvent(drain()[0], {
    eventName: 'PreToolUse',
    state: 'running_command',
    toolName: 'pwsh',
  })
})

await scenario('文件工具映射为 editing_file', () => {
  emit('session/event', rootSession, {
    type: 'tool/call',
    data: { callId: 'c2', name: 'write', arguments: '{}' },
  })
  expectEvent(drain()[0], {
    eventName: 'PreToolUse',
    state: 'editing_file',
    toolName: 'write',
  })
})

await scenario('未单独约定的工具退回 working', () => {
  emit('session/event', rootSession, {
    type: 'tool/call',
    data: { callId: 'c3', name: 'web_search', arguments: '{}' },
  })
  expectEvent(drain()[0], { eventName: 'PreToolUse', state: 'working', toolName: 'web_search' })
})

await scenario('ask_user_question 映射为等待输入并带问题文本', () => {
  emit('session/event', rootSession, {
    type: 'tool/call',
    data: {
      callId: 'c4',
      name: 'ask_user_question',
      arguments: '{"questions":[{"id":"q1","question":"方案 A 还是方案 B？"}]}',
    },
  })
  expectEvent(drain()[0], {
    eventName: 'PermissionRequest',
    state: 'waiting_input',
    message: 'DSH 等待你确认：方案 A 还是方案 B？',
  })
})

await scenario('回答完之后 tool/result 恢复思考状态', () => {
  emit('session/event', rootSession, { type: 'tool/result', data: { message: { callId: 'c4' } } })
  expectEvent(drain()[0], {
    eventName: 'Notification',
    state: 'thinking',
    message: 'DSH 已收到你的选择，继续处理',
  })
})

await scenario('普通 tool/result 上报工具完成', () => {
  emit('session/event', rootSession, { type: 'tool/result', data: { message: { callId: 'c1' } } })
  expectEvent(drain()[0], { eventName: 'PostToolUse', state: 'thinking' })
})

await scenario('turn/end completed 映射为完成且不被 status idle 重复上报', () => {
  emit('session/event', rootSession, {
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  })
  emit('agent/status', { agent, status: 'idle' })
  const payloads = drain()
  assert.equal(payloads.length, 1, 'status idle 不应重复上报终止事件')
  expectEvent(payloads[0], { eventName: 'Stop', state: 'success', message: 'DSH 回合完成' })
})

await scenario('没有 turn/end 的 running→idle 由 status 兜底收尾', () => {
  emit('agent/status', { agent, status: 'running' })
  drain()
  emit('agent/status', { agent, status: 'idle' })
  expectEvent(drain()[0], { eventName: 'Stop', state: 'success' })
})

await scenario('turn/end aborted 回到空闲而不是报错', () => {
  emit('agent/status', { agent, status: 'running' })
  drain()
  emit('session/event', rootSession, {
    type: 'turn/end',
    data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  emit('agent/status', { agent, status: 'idle' })
  const payloads = drain()
  assert.equal(payloads.length, 1)
  expectEvent(payloads[0], { eventName: 'Stop', state: 'idle' })
})

await scenario('turn/end 异常原因映射为错误状态', () => {
  emit('agent/status', { agent, status: 'running' })
  drain()
  emit('session/event', rootSession, {
    type: 'turn/end',
    data: { reason: { kind: 'max-tokens' } },
  })
  expectEvent(drain()[0], {
    eventName: 'StopFailure',
    state: 'error',
    message: 'DSH 回合失败（max-tokens）',
  })
})

await scenario('子代理会话默认不上报', () => {
  const subagentSession = { id: 'session-child', header: { cwd: 'D:\\x', delegationDepth: 1 } }
  emit('agent/status', {
    agent: { id: 'session-child', status: 'running', session: subagentSession },
    status: 'running',
  })
  emit('session/event', subagentSession, { type: 'turn/start', data: { turn: 1 } })
  assert.equal(drain().length, 0)
})

await scenario('异常载荷不抛错，只做合法降级', () => {
  emit('agent/status', undefined)
  emit('session/event', undefined, undefined)
  emit('session/event', rootSession, { type: 'tool/call' })
  emit('session/event', rootSession, { type: 'user/message', data: { message: { content: 'oops' } } })
  emit('agent/disposed', undefined)
  const payloads = drain()
  assert.equal(payloads.length, 2)
  expectEvent(payloads[0], { eventName: 'PreToolUse', state: 'working', toolName: 'tool' })
  expectEvent(payloads[1], { eventName: 'UserPromptSubmit', state: 'thinking' })
})

await scenario('未知事件类型被忽略', () => {
  emit('session/event', rootSession, { type: 'session/title', data: { title: '某个标题' } })
  assert.equal(drain().length, 0)
})

await scenario('会话关闭上报 SessionEnd', () => {
  emit('agent/disposed', { agent })
  expectEvent(drain()[0], { eventName: 'SessionEnd', state: 'idle' })
})

await scenario('卸载时释放全部监听', async () => {
  assert.equal(typeof cleanup, 'function')
  await cleanup()
  assert.equal(handlers.get('agent/status').length, 0)
  assert.equal(handlers.get('session/event').length, 0)
  assert.equal(handlers.get('agent/disposed').length, 0)
})

rmSync(inbox, { recursive: true, force: true })
console.log(`\n全部通过：${passed} 个场景`)
