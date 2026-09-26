import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import {
  decodeSessionAction,
  encodeSessionAction,
  migrateSessionCollections,
  sessionIdentity,
} from "../app/agent-context.mjs"
import {
  externalTerminalTurn,
  terminalEventFromNotification,
} from "../adapters/codex-app-server.mjs"

const metrics = {}
const measure = async (name, operation) => {
  const started = performance.now()
  const result = await operation()
  metrics[name] = Math.round(performance.now() - started)
  return result
}

await measure("callback100kMs", async () => {
  for (let index = 0; index < 100000; index += 1) {
    const backend = index % 2 ? "codex" : "opencode"
    const id = backend === "codex"
      ? `01a0b070-fa08-76c1-bcdf-${String(index).padStart(12, "0")}`
      : `ses_${String(index).padStart(24, "0")}`
    const action = index % 3 === 0 ? "select" : index % 3 === 1 ? "show" : "stopask"
    const value = encodeSessionAction(action, {
      backend,
      id: `event:${id}:turn:${index}`,
      sessionId: id,
    })
    assert.ok(Buffer.byteLength(value, "utf8") <= 64)
    assert.deepEqual(decodeSessionAction(value, action), { backend, id })
  }
})

await measure("identityMigration20kMs", async () => {
  const state = { queues: {}, queueInFlight: {}, queuePaused: {}, queueStartOnIdle: {}, recentEvents: {} }
  for (let index = 0; index < 20000; index += 1) {
    const id = `session-${index}`
    state.queues[id] = [{ id: `queue-${index}` }]
    const session = index % 2
      ? { backend: "codex", instanceId: "codex-local", id }
      : { backend: "opencode", serverUrl: `http://127.0.0.1:${4000 + (index % 10)}`, id }
    const key = migrateSessionCollections(state, session)
    assert.equal(key, sessionIdentity(session))
    assert.equal(state.queues[key][0].id, `queue-${index}`)
    assert.equal(state.queues[id], undefined)
  }
})

await measure("codexTerminal100kMs", async () => {
  const observed = new Set()
  for (let index = 0; index < 100000; index += 1) {
    const id = `turn-${index}`
    const transient = {
      turns: [
        { id: `old-${index}`, status: "completed", completedAt: 1700000000 + index },
        { id, status: "interrupted", startedAt: 1700100000 + index, completedAt: null },
      ],
    }
    assert.equal(externalTerminalTurn(transient, { observedTurns: observed }), null)
    const completed = { id, status: "completed", completedAt: 1700200000 + index, items: [{ type: "agentMessage", text: "done" }] }
    assert.equal(externalTerminalTurn({ turns: [completed] }, { observedTurns: observed }), completed)
    const event = terminalEventFromNotification({ threadId: `thread-${index}`, turn: completed })
    assert.equal(event.type, "session.idle")
    assert.equal(event.excerpt, "done")
  }
})

const root = await mkdtemp(join(tmpdir(), "agent-task-hub-stress-"))
try {
  process.env.AGENT_TASK_HUB_DATA_DIR = root
  delete process.env.OPENCODE_SERVER_PASSWORD
  await writeFile(join(root, "config.json"), "{}", "utf8")
  const { TelegramBridgePlugin } = await import(`../adapters/opencode.js?stress=${Date.now()}`)
  const client = {
    session: {
      async get({ path }) {
        return { data: { id: path.id, title: `Stress ${path.id}`, directory: "D:/stress", summary: { files: 1, additions: 1, deletions: 0 } } }
      },
      async messages({ path }) {
        return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: `done ${path.id}` }] }] }
      },
    },
  }
  const hooks = await TelegramBridgePlugin({ client, directory: "D:/stress", serverUrl: new URL("http://127.0.0.1:4096") })
  const eventCount = 500
  await measure("openCodeConcurrent500Ms", async () => {
    await Promise.all(Array.from({ length: eventCount }, (_, index) => hooks.event({
      event: { type: "session.idle", properties: {
        sessionID: `ses_stress_${String(index).padStart(4, "0")}`,
      } },
    })))
  })
  const files = await readdir(join(root, "events"))
  assert.equal(files.filter((name) => name.endsWith(".json")).length, eventCount)
  assert.equal(files.filter((name) => name.endsWith(".tmp")).length, 0)
  const ids = new Set()
  for (const name of files) {
    const event = JSON.parse(await readFile(join(root, "events", name), "utf8"))
    ids.add(event.id)
    assert.match(event.sessionId, /^ses_stress_/)
    assert.match(event.excerpt, /^done ses_stress_/)
  }
  assert.equal(ids.size, eventCount)
  metrics.openCodeEvents = eventCount
} finally {
  await rm(root, { recursive: true, force: true })
}

metrics.heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
console.log("STRESS_TEST=PASS " + JSON.stringify(metrics))
