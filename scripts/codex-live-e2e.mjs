import assert from "node:assert/strict"
import { CodexAppServer } from "../adapters/codex-app-server.mjs"

if (process.env.AGENT_TASK_HUB_LIVE_E2E !== "1") {
  throw new Error("Set AGENT_TASK_HUB_LIVE_E2E=1 to run the model-backed live test")
}

const wsUrl = process.env.AGENT_TASK_HUB_CODEX_WS_URL || "ws://127.0.0.1:9234"
const cwd = process.env.AGENT_TASK_HUB_E2E_CWD || process.cwd()
const timeoutMs = Number(process.env.AGENT_TASK_HUB_E2E_TIMEOUT_MS || 240000)
const client = new CodexAppServer({ transport: "shared", wsUrl, requestTimeoutMs: 60000 })
const terminalEvents = []
let threadId = null
let activeTurnId = null

client.on("terminal", (event) => terminalEvents.push(event))
client.on("serverRequest", (message) => {
  client.respondError(message.id, -32601, "Live E2E prompts do not permit tools or interactive requests")
})

function waitForTerminal(turnId) {
  const existing = terminalEvents.find((event) => event.turnId === turnId)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("terminal", onTerminal)
      reject(new Error(`Timed out waiting for turn ${turnId}`))
    }, timeoutMs)
    const onTerminal = (event) => {
      if (event.turnId !== turnId) return
      clearTimeout(timer)
      client.off("terminal", onTerminal)
      resolve(event)
    }
    client.on("terminal", onTerminal)
  })
}

async function startAndWait(text) {
  const turn = await client.sendPrompt(threadId, text)
  assert.ok(turn?.id, "turn/start returned no turn id")
  activeTurnId = turn.id
  const event = await waitForTerminal(turn.id)
  activeTurnId = null
  return event
}

const result = { wsUrl, cwd, checks: [] }

try {
  await client.start()
  result.checks.push("initialize")

  const thread = await client.startThread({ cwd })
  assert.ok(thread?.id, "thread/start returned no thread id")
  threadId = String(thread.id)
  result.threadId = threadId
  result.checks.push("thread/start")

  const first = await startAndWait("Agent Task Hub E2E step 1. Reply with exactly ATH_E2E_FIRST_OK. Do not use tools or change files.")
  assert.equal(first.status, "completed")
  assert.match(first.excerpt, /ATH_E2E_FIRST_OK/)
  result.checks.push("first turn + completion event")

  const second = await startAndWait("Agent Task Hub E2E step 2. If the previous reply was ATH_E2E_FIRST_OK, reply with exactly ATH_E2E_APPEND_OK. Do not use tools or change files.")
  assert.equal(second.status, "completed")
  assert.match(second.excerpt, /ATH_E2E_APPEND_OK/)
  result.checks.push("follow-up turn + context")

  const steerTurn = await client.sendPrompt(threadId, "Agent Task Hub E2E steering target. Write a very long essay of at least 3000 words about software testing. Do not use tools or change files.")
  assert.ok(steerTurn?.id)
  activeTurnId = steerTurn.id
  const acceptedTurnId = await client.steer(threadId, "Replace the requested essay with exactly ATH_E2E_STEER_OK.")
  assert.equal(acceptedTurnId, steerTurn.id)
  const steered = await waitForTerminal(steerTurn.id)
  activeTurnId = null
  assert.equal(steered.status, "completed")
  assert.match(steered.excerpt, /ATH_E2E_STEER_OK/)
  result.checks.push("turn/steer")

  const interruptTurn = await client.sendPrompt(threadId, "Agent Task Hub E2E interrupt target. Produce an extremely long numbered list with 10000 detailed entries. Do not use tools or change files.")
  assert.ok(interruptTurn?.id)
  activeTurnId = interruptTurn.id
  await client.interrupt(threadId)
  const interrupted = await waitForTerminal(interruptTurn.id)
  activeTurnId = null
  assert.equal(interrupted.status, "interrupted")
  result.checks.push("turn/interrupt")

  const read = await client.readThread(threadId)
  assert.equal(read.id, threadId)
  assert.ok((read.turns || []).length >= 4)
  result.turns = read.turns.length
  result.checks.push("thread/read")

  const listed = await client.listSessions({ limit: 100 })
  assert.ok(listed.some((session) => session.id === threadId), "new appServer thread was missing from thread/list")
  result.checks.push("thread/list appServer source")

  await client.archiveThread(threadId)
  const afterArchive = await client.listSessions({ limit: 100 })
  assert.ok(!afterArchive.some((session) => session.id === threadId), "archived thread remained in active list")
  result.checks.push("thread/archive cleanup")
  threadId = null

  result.ok = true
  console.log(`CODEX_LIVE_E2E=PASS ${JSON.stringify(result)}`)
} catch (error) {
  result.ok = false
  result.error = error?.message || String(error)
  console.error(`CODEX_LIVE_E2E=FAIL ${JSON.stringify(result)}`)
  process.exitCode = 1
} finally {
  if (threadId && activeTurnId) await client.interrupt(threadId).catch(() => {})
  if (threadId) await client.archiveThread(threadId).catch(() => {})
  await client.stop().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 50)
}
