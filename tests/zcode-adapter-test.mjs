import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { resolveZCodeBundle, upsertZCodeTaskIndex, zcodeIndexCompletion, zcodeSessionNeedsEventPoll, zcodeSessionToHubSession, zcodeTaskIndexRecord, zcodeTerminalEvent } from "../adapters/zcode-app-server.mjs"

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
} finally { rmSync(dataRoot, { recursive: true, force: true }) }

assert.equal(typeof resolveZCodeBundle, "function")
if (process.env.AGENT_TASK_HUB_TEST_ZCODE_BUNDLE) assert.equal(typeof resolveZCodeBundle(process.env.AGENT_TASK_HUB_TEST_ZCODE_BUNDLE), "string")
console.log("ZCODE_ADAPTER_TEST=PASS")
