import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ZCodeAppServer, zcodeLocalReply } from "../adapters/zcode-app-server.mjs"

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
messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("msg_1", "sess_desktop", now + 500, JSON.stringify({ role: "assistant", finish: "stop" }))
messages.prepare("INSERT INTO part VALUES (?,?,?)").run("msg_1", 1, JSON.stringify({ type: "text", text: "Created the README and verified the links." }))
assert.equal(zcodeLocalReply(dataRoot, "sess_desktop", now + 1000), "Created the README and verified the links.")
assert.equal(zcodeLocalReply(dataRoot, "another_session", now + 1000), "")
assert.equal(zcodeLocalReply(dataRoot, "sess_desktop", now + 20 * 60_000), "")
messages.prepare("INSERT INTO message VALUES (?,?,?,?)").run("msg_2", "sess_desktop", now + 2000, JSON.stringify({ role: "user" }))
assert.equal(zcodeLocalReply(dataRoot, "sess_desktop", now + 3000), "")
const client = new ZCodeAppServer({ dataRoot })
client.listSessions = async () => []
const events = []
client.on("terminal", (event) => events.push(event))
try {
  await client.startMonitor({ intervalMs: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(events.length, 0, "baseline must not announce an old task")
  database.prepare("UPDATE tasks SET task_status = ?, updated_at = ? WHERE task_id = ?").run("completed", now + 1000, "sess_desktop")
  await new Promise((resolve) => setTimeout(resolve, 2300))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, "session.idle")
  assert.equal(events[0].sessionId, "sess_desktop")
  assert.equal(events[0].excerpt, "Created the README and verified the links.")
  await new Promise((resolve) => setTimeout(resolve, 2200))
  assert.equal(events.length, 1, "unchanged completed task must not repeat")
} finally {
  await client.stop()
  messages.close()
  database.close()
  rmSync(root, { recursive: true, force: true })
}
console.log("ZCODE_INDEX_MONITOR_TEST=PASS")
