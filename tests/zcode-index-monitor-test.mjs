import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ZCodeAppServer, zcodeLocalReply, zcodeDesktopSessions, zcodeLocalModel, zcodeLocalActivity } from "../adapters/zcode-app-server.mjs"

const root = mkdtempSync(join(tmpdir(), "agent-task-hub-zcode-monitor-"))
const dataRoot = join(root, "v2")
const cliDbDir = join(root, "cli", "db")
mkdirSync(dataRoot)
mkdirSync(cliDbDir, { recursive: true })
const database = new DatabaseSync(join(dataRoot, "tasks-index.sqlite"))
database.exec("CREATE TABLE tasks (task_id TEXT, task_status TEXT, updated_at INTEGER, title TEXT, workspace_path TEXT, deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)")
const now = Date.now()
database.prepare("INSERT INTO tasks (task_id,task_status,updated_at,title,workspace_path) VALUES (?,?,?,?,?)").run("sess_desktop", "running", now, "Desktop task", "C:\\work")
const messages = new DatabaseSync(join(cliDbDir, "db.sqlite"))
messages.exec("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (message_id TEXT, sequence INTEGER, data TEXT)")
messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("msg_1", "sess_desktop", now - 500, JSON.stringify({ role: "assistant", finish: "stop" }))
messages.prepare("INSERT INTO part VALUES (?,?,?)").run("msg_1", 1, JSON.stringify({ type: "text", text: "Created the README and verified the links." }))
assert.equal(zcodeLocalReply(dataRoot, "sess_desktop", now + 1000), "Created the README and verified the links.")
assert.equal(zcodeLocalReply(dataRoot, "another_session", now + 1000), "")
assert.equal(zcodeLocalReply(dataRoot, "sess_desktop", now + 20 * 60_000), "")
messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("msg_2", "sess_desktop", now + 2000, JSON.stringify({ role: "user" }))
assert.equal(zcodeLocalReply(dataRoot, "sess_desktop", now + 3000), "")
// Desktop state must win over the independent server's idle snapshot.
database.exec("ALTER TABLE tasks ADD COLUMN model TEXT; ALTER TABLE tasks ADD COLUMN meta_json TEXT")
database.prepare("UPDATE tasks SET model = ?, meta_json = ? WHERE task_id = ?").run("account:test/GLM-5.3-Flash", JSON.stringify({ thoughtLevel: "max", mode: "yolo" }), "sess_desktop")
const discovery = new ZCodeAppServer({ dataRoot })
discovery.request = async (method) => method === "session/list"
  ? { sessions: [{ sessionId: "sess_desktop", sessionKind: "interactive", status: "idle" }] }
  : { session: { sessionId: "sess_desktop", status: "idle", mode: "build" }, messages: [], settings: {} }
const listed = await discovery.listSessions()
assert.equal(listed[0].status, "busy")
assert.equal(listed[0].model.modelId, "GLM-5.3-Flash")
assert.equal(listed[0].thoughtLevel, "max")
const detail = await discovery.readSession("sess_desktop")
assert.equal(detail.session.status, "running")
assert.equal(detail.session.model.modelId, "GLM-5.3-Flash")
assert.equal(detail.session.thoughtLevel, "max")
assert.equal(zcodeDesktopSessions(dataRoot)[0].status, "running", "reading details must not mutate Desktop status")
assert.equal(JSON.parse(database.prepare("SELECT meta_json FROM tasks WHERE task_id = ?").get("sess_desktop").meta_json).mode, "yolo")
// Desktop-only sessions still appear when the app-server list omits them.
discovery.request = async () => ({ sessions: [] })
assert.equal((await discovery.listSessions())[0].id, "sess_desktop")
messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("msg_model", "sess_desktop", now + 2500, JSON.stringify({ role: "user", model: { providerID: "account:test", modelID: "GLM-5.3", variant: "max" } }))
assert.deepEqual(zcodeLocalModel(dataRoot, "sess_desktop").model.modelId, "GLM-5.3")
assert.equal(zcodeLocalModel(dataRoot, "sess_desktop").thoughtLevel, "max")

messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("activity_reply", "activity_only", now + 100, JSON.stringify({ role: "assistant", finish: "tool-calls" }))
messages.prepare("INSERT INTO part VALUES (?,?,?)").run("activity_reply", 1, JSON.stringify({ type: "text", text: "Working on the tests." }))
messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("activity_empty", "activity_only", now + 200, JSON.stringify({ role: "assistant" }))
const activity = zcodeLocalActivity(dataRoot, "activity_only", { now: now + 300, includeReply: true })
assert.equal(activity.status, "running")
assert.equal(activity.latestReply, "Working on the tests.", "empty streaming message must not hide previous assistant text")
database.prepare("INSERT INTO tasks (task_id,task_status,updated_at,title,workspace_path) VALUES (?,?,?,?,?)").run("activity_only", "error", now - 1000, "Old error", "C:/work")
const oldErrorClient = new ZCodeAppServer({ dataRoot })
oldErrorClient.request = async (method) => method === "session/list" ? { sessions: [] } : { session: { sessionId: "activity_only", status: "idle" } }
assert.equal((await oldErrorClient.listSessions()).find(s => s.id === "activity_only").status, "busy")
const recoveredDetail = await oldErrorClient.readSession("activity_only")
assert.equal(recoveredDetail.session.status, "running", "fresh execution must supersede old error index")
assert.equal(recoveredDetail.latestReply, "Working on the tests.")

const client = new ZCodeAppServer({ dataRoot })
client.listSessions = async () => []
client.residentSessions.add("sess_desktop")
client.subscriptions.add("sess_desktop")
const events = []
client.on("terminal", (event) => events.push(event))
try {
  await client.startMonitor({ intervalMs: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(events.length, 0, "baseline must not announce an old task")
  database.prepare("UPDATE tasks SET task_status = ?, updated_at = ? WHERE task_id = ?").run("completed", now + 1000, "sess_desktop")
  await new Promise((resolve) => setTimeout(resolve, 2300))
  assert.equal(events.length, 1, "Desktop completion must still be monitored after the session was controlled from Telegram")
  assert.equal(events[0].type, "session.idle")
  assert.equal(events[0].sessionId, "sess_desktop")
  assert.equal(events[0].excerpt, "Created the README and verified the links.")
  await new Promise((resolve) => setTimeout(resolve, 2200))
  assert.equal(events.length, 1, "unchanged completed task must not repeat")

  // An index fallback can arrive before RPC replay. The same task must notify
  // only once, while a later user prompt in this session must still notify.
  const replayClient = new ZCodeAppServer({ dataRoot })
  replayClient.listSessions = async () => []
  replayClient.residentSessions.add("sess_desktop")
  replayClient.subscriptions.add("sess_desktop")
  const replayEvents = []
  replayClient.on("terminal", (event) => replayEvents.push(event))
  const poll = async () => {
    await replayClient.startMonitor({ intervalMs: 60000 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(replayClient.monitorBusy, false)
  }
  try {
    const firstEnd = Date.now() + 1000
    messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("turn_user_1", "sess_desktop", firstEnd - 100, JSON.stringify({ role: "user" }))
    await poll()
    database.prepare("UPDATE tasks SET task_status = ?, updated_at = ? WHERE task_id = ?").run("completed", firstEnd, "sess_desktop")
    await poll()
    assert.equal(replayEvents.length, 1)
    assert.equal(replayEvents[0].taskMessageId, "turn_user_1")
    replayClient.eventSeq.set("sess_desktop", 0)
    replayClient.listSessions = async () => [{ id: "sess_desktop", status: "busy", updatedAt: firstEnd }]
    replayClient.request = async () => ({ events: [{
      eventId: "replayed-terminal", sessionId: "sess_desktop", turnId: "rpc-turn-1", seq: 1,
      type: "turn.completed", timestamp: firstEnd + 10, payload: { resultType: "success", response: "Done" },
    }] })
    await poll()
    assert.equal(replayEvents.length, 1, "index completion and replayed RPC completion are one task")

    const secondEnd = firstEnd + 1000
    messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("turn_user_2", "sess_desktop", secondEnd - 100, JSON.stringify({ role: "user" }))
    database.prepare("UPDATE tasks SET task_status = ?, updated_at = ? WHERE task_id = ?").run("completed", secondEnd, "sess_desktop")
    await poll()
    assert.equal(replayEvents.length, 2, "a new Desktop task must not be suppressed by an earlier RPC subscription")
    assert.equal(replayEvents[1].taskMessageId, "turn_user_2")
  } finally { await replayClient.stop() }
} finally {
  await client.stop()
  messages.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
}
console.log("ZCODE_INDEX_MONITOR_TEST=PASS")
