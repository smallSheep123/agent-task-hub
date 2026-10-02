import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ZCodeAppServer, resolveZCodeBundle, upsertZCodeTaskIndex, zcodeIndexCompletion, zcodeSessionNeedsEventPoll, zcodeSessionToHubSession, zcodeTaskIndexRecord, zcodeTerminalEvent } from "../adapters/zcode-app-server.mjs"

const session = zcodeSessionToHubSession({
  sessionId: "sess_1",
  title: "Fix the build",
  workspace: { workspacePath: "C:\\work", workspaceKey: "local:test" },
  status: "running",
  model: { providerId: "account:test", modelId: "GLM-5.3", options: { reasoningLevel: "high" } },
  createdAt: 1700000000000,
  updatedAt: 1700000010000,
})
assert.equal(session.backend, "zcode")
assert.equal(session.status, "busy")
assert.equal(session.directory, "C:\\work")
assert.equal(session.model.modelId, "GLM-5.3")

const completed = zcodeTerminalEvent({
  eventId: "event_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  type: "turn.completed",
  timestamp: 1700000020000,
  payload: { response: "Done", resultType: "success", duration: 1200 },
}, { sessionId: "sess_1", title: "Fix the build", workspace: { workspacePath: "C:\\work" } })
assert.equal(completed.type, "session.idle")
assert.equal(completed.excerpt, "Done")
assert.equal(completed.durationMs, 1200)

const cancelled = zcodeTerminalEvent({ eventId: "event_2", sessionId: "sess_1", type: "turn.completed", payload: { resultType: "cancelled" } })
assert.equal(cancelled.type, "session.interrupted")
const failed = zcodeTerminalEvent({ eventId: "event_3", sessionId: "sess_1", type: "turn.failed", payload: { error: { message: "boom" } } })
assert.equal(failed.type, "session.error")
assert.equal(failed.error, "boom")

const resultFailure = zcodeTerminalEvent({ type: "turn.completed", payload: { resultType: "error", response: "No model selected" } })
assert.equal(resultFailure.type, "session.error")
assert.equal(resultFailure.error, "No model selected")
const resumedClient = new ZCodeAppServer({ dataRoot: "nonexistent-test-root" })
resumedClient.sessions.set("resume_model", { sessionId: "resume_model", model: { providerId: "account:test", modelId: "GLM-5.3-Flash" }, thoughtLevel: "max" })
const restoreCalls = []
resumedClient.request = async (method, params) => {
  restoreCalls.push({ method, params })
  return method === "session/read" ? { settings: { model: {}, thoughtLevel: {} } } : {}
}
await resumedClient.resume("resume_model")
assert.deepEqual(restoreCalls.map(x => x.method), ["session/resume", "session/read", "session/setModel", "session/setThoughtLevel"])
assert.equal(restoreCalls[2].params.model.modelId, "GLM-5.3-Flash")
assert.equal(restoreCalls[3].params.thoughtLevel, "max")
resumedClient.request = async () => ({ accepted: false })
// Avoid subscribing or touching the filesystem for this rejection test.
resumedClient.subscriptions.add("resume_model")
await assert.rejects(resumedClient.sendPrompt("resume_model", "test"), /did not accept/)

const idlePollTarget = { status: "idle", updatedAt: 1700000010000 }
assert.equal(zcodeSessionNeedsEventPoll(idlePollTarget, { baseline: true, previousVersion: 1700000010000 }), true)
assert.equal(zcodeSessionNeedsEventPoll(idlePollTarget, { previousVersion: undefined }), true)
assert.equal(zcodeSessionNeedsEventPoll({ ...idlePollTarget, status: "running" }, { previousVersion: 1700000010000 }), true)
assert.equal(zcodeSessionNeedsEventPoll({ ...idlePollTarget, updatedAt: 1700000020000 }, { previousVersion: 1700000010000 }), true)
assert.equal(zcodeSessionNeedsEventPoll(idlePollTarget, { previousVersion: 1700000010000, subscribed: true, lastPolledAt: 1000, now: 32000 }), true)
assert.equal(zcodeSessionNeedsEventPoll(idlePollTarget, { previousVersion: 1700000010000, subscribed: true, lastPolledAt: 10000, now: 32000 }), false)
assert.equal(zcodeSessionNeedsEventPoll(idlePollTarget, { previousVersion: 1700000010000 }), false)
assert.equal(zcodeIndexCompletion(null, { status: "completed", updatedAt: 2000 }, 1000), false)
assert.equal(zcodeIndexCompletion({ status: "running", updatedAt: 1000 }, { status: "completed", updatedAt: 2000 }, 1500), true)
assert.equal(zcodeIndexCompletion({ status: "completed", updatedAt: 1000 }, { status: "completed", updatedAt: 2000 }, 1500), true)
assert.equal(zcodeIndexCompletion({ status: "completed", updatedAt: 1000 }, { status: "completed", updatedAt: 1000 }, 1500), false)

const record = zcodeTaskIndexRecord({
  sessionId: "sess_indexed",
  title: "Telegram task",
  workspace: { workspacePath: "C:\\work" },
  status: "running",
  mode: "build",
  model: { providerId: "account:test", modelId: "GLM-5.3", options: { reasoningLevel: "high" } },
  createdAt: 1700000000000,
  updatedAt: 1700000010000,
})
assert.equal(record.workspaceKey, "C:\\work")
assert.equal(record.model, "account:test/GLM-5.3")
assert.equal(record.status, "running")
assert.equal(zcodeTaskIndexRecord({ sessionId: "cancelled", status: "cancelled" }).status, "cancelled")

const dataRoot = mkdtempSync(join(tmpdir(), "agent-task-hub-zcode-index-"))
try {
  const database = new DatabaseSync(join(dataRoot, "tasks-index.sqlite"))
  database.exec(`CREATE TABLE tasks (
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
    task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT, provider TEXT,
    mode TEXT NOT NULL DEFAULT 'build', model TEXT, migration_source TEXT,
    forked_from_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    unread_at INTEGER, last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
    title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
    searchable_text TEXT NOT NULL DEFAULT '', cron_automation_id TEXT, off_peak_task_id TEXT,
    PRIMARY KEY(workspace_key, task_id)
  )`)
  database.close()
  assert.equal(upsertZCodeTaskIndex(dataRoot, {
    sessionId: "sess_indexed", title: "Telegram task", workspace: { workspacePath: "C:\\work" },
    status: "running", mode: "build", model: { providerId: "account:test", modelId: "GLM-5.3" },
    createdAt: 1700000000000, updatedAt: 1700000010000,
  }), true)
  assert.equal(upsertZCodeTaskIndex(dataRoot, {
    sessionId: "sess_indexed", title: "Telegram task", workspace: { workspacePath: "C:\\work" },
    status: "completed", mode: "build", model: { providerId: "account:test", modelId: "GLM-5.3" },
    createdAt: 1700000000000, updatedAt: 1700000020000,
  }), true)
  const check = new DatabaseSync(join(dataRoot, "tasks-index.sqlite"), { readOnly: true })
  const indexed = check.prepare("SELECT * FROM tasks WHERE task_id = ?").get("sess_indexed")
  check.close()
  assert.equal(indexed.task_status, "completed")
  assert.equal(indexed.updated_at, 1700000020000)
  assert.equal(JSON.parse(indexed.meta_json).model, "account:test/GLM-5.3")

  const sender = new ZCodeAppServer({ dataRoot })
  sender.sessions.set("sess_indexed", {
    sessionId: "sess_indexed", title: "Telegram task", workspace: { workspacePath: "C:\\work" },
    model: { providerId: "account:test", modelId: "GLM-5.3" },
  })
  sender.residentSessions.add("sess_indexed")
  sender.subscriptions.add("sess_indexed")
  const storedState = () => {
    const db = new DatabaseSync(join(dataRoot, "tasks-index.sqlite"), { readOnly: true })
    try { return db.prepare("SELECT task_status, updated_at FROM tasks WHERE task_id = ?").get("sess_indexed") }
    finally { db.close() }
  }
  const beforeRejected = storedState()
  sender.request = async () => ({ accepted: false })
  await assert.rejects(sender.sendPrompt("sess_indexed", "rejected"), /did not accept/)
  assert.deepEqual(storedState(), beforeRejected, "a rejected prompt must not leave a false running task in Desktop")
  let sentParams
  sender.request = async (_method, params) => {
    sentParams = params
    throw new Error("ZCode request timed out: session/send")
  }
  await assert.rejects(sender.sendPrompt("sess_indexed", "uncertain"), (error) => {
    assert.equal(error.code, "ZCODE_ACK_UNCERTAIN")
    assert.equal(error.sessionId, "sess_indexed")
    assert.equal(error.inputId, sentParams.inputId)
    assert.equal(error.queryId, sentParams.queryId)
    return true
  })
  assert.deepEqual(storedState(), beforeRejected, "an unconfirmed acknowledgement must not invent a running state")
  sender.request = async () => {
    const error = new Error("ZCode app-server stopped (code=1)")
    error.requestSubmitted = true
    throw error
  }
  await assert.rejects(sender.sendPrompt("sess_indexed", "lost acknowledgement"), { code: "ZCODE_ACK_UNCERTAIN" })
  assert.deepEqual(storedState(), beforeRejected, "a lost connection after submission must remain uncertain")
  const unwritable = new ZCodeAppServer({ dataRoot })
  unwritable.residentSessions.add("sess_indexed")
  unwritable.subscriptions.add("sess_indexed")
  unwritable.process = { exitCode: null, killed: false, stdin: { writable: true, write() { throw new Error("pipe closed before write") } } }
  await assert.rejects(unwritable.sendPrompt("sess_indexed", "not written"), (error) => {
    assert.equal(error.requestSubmitted, false)
    assert.notEqual(error.code, "ZCODE_ACK_UNCERTAIN")
    return true
  })
  assert.equal(unwritable.pending.size, 0, "synchronous write failure must clean its pending request and timer")
  sender.request = async () => ({ accepted: true, turnId: "direct-turn" })
  assert.equal((await sender.sendPrompt("sess_indexed", "accepted")).id, "direct-turn")
  assert.equal(storedState().task_status, "running")
  sender.request = async () => ({ accepted: true, turn: { id: "nested-turn" } })
  assert.equal((await sender.sendPrompt("sess_indexed", "accepted nested")).id, "nested-turn")
  sender.lastStartedTurns.set("sess_indexed", { id: "older-turn", startedAt: Date.now() - 1000 })
  sender.request = async () => ({ accepted: true })
  assert.equal((await sender.sendPrompt("sess_indexed", "no new event")).id, null, "an old turn ID must never be attached to a new prompt")
  sender.request = async () => {
    sender.lastStartedTurns.set("sess_indexed", { id: "observed-turn", startedAt: Date.now() })
    return { accepted: true }
  }
  assert.equal((await sender.sendPrompt("sess_indexed", "new event")).id, "observed-turn")
  upsertZCodeTaskIndex(dataRoot, sender.sessions.get("sess_indexed"), { status: "cancelled" })
  assert.equal(storedState().task_status, "cancelled", "interrupted work must remain cancelled in the Desktop index")
} finally { rmSync(dataRoot, { recursive: true, force: true }) }

assert.equal(typeof resolveZCodeBundle, "function")
if (process.env.AGENT_TASK_HUB_TEST_ZCODE_BUNDLE) assert.equal(typeof resolveZCodeBundle(process.env.AGENT_TASK_HUB_TEST_ZCODE_BUNDLE), "string")
console.log("ZCODE_ADAPTER_TEST=PASS")
