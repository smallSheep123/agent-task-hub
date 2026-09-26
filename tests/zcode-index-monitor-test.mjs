import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ZCodeAppServer } from "../adapters/zcode-app-server.mjs"

const root = mkdtempSync(join(tmpdir(), "agent-task-hub-zcode-monitor-"))
const database = new DatabaseSync(join(root, "tasks-index.sqlite"))
database.exec("CREATE TABLE tasks (task_id TEXT, task_status TEXT, updated_at INTEGER, title TEXT, workspace_path TEXT, deleted INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)")
const now = Date.now()
database.prepare("INSERT INTO tasks (task_id,task_status,updated_at,title,workspace_path) VALUES (?,?,?,?,?)").run("sess_desktop", "running", now, "Desktop task", "C:\\work")
const client = new ZCodeAppServer({ dataRoot: root })
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
  await new Promise((resolve) => setTimeout(resolve, 2200))
  assert.equal(events.length, 1, "unchanged completed task must not repeat")
} finally {
  await client.stop()
  database.close()
  rmSync(root, { recursive: true, force: true })
}
console.log("ZCODE_INDEX_MONITOR_TEST=PASS")
