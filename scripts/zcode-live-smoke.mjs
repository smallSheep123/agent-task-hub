import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ZCodeAppServer } from "../adapters/zcode-app-server.mjs"

const live = process.argv.includes("--send")
const bundleArg = process.argv.find((value) => value.startsWith("--bundle="))?.slice(9) || ""
const client = new ZCodeAppServer({ bundle: bundleArg })
let workspace = null
let testSessionId = null

try {
  client.on("diagnostic", (message) => console.error(`ZCODE_DIAGNOSTIC=${message}`))
  await client.start()
  const sessions = await client.listSessions({ limit: 20 })
  console.log(`ZCODE_LIVE_START=PASS sessions=${sessions.length}`)
  if (sessions[0]) {
    const snapshot = await client.readSession(sessions[0].id, 2)
    console.log(`ZCODE_LIVE_READ=PASS status=${snapshot?.session?.status || snapshot?.status || "unknown"}`)
  }
  if (!live) {
    console.log("ZCODE_LIVE_SMOKE=PASS")
  } else {
    workspace = join(process.cwd(), ".zcode-live-e2e-workspace")
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, "README.md"), "# Agent Task Hub ZCode live test\n", "utf8")
    const session = await client.startSession({ cwd: workspace, title: "Agent Task Hub live visibility check" })
    testSessionId = session.id
    const index = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"), { readOnly: true })
    const indexed = index.prepare("SELECT task_id, title, task_status FROM tasks WHERE task_id = ?").get(session.id)
    index.close()
    if (!indexed || indexed.title !== "Agent Task Hub live visibility check") throw new Error("ZCode Desktop task index was not updated")
    console.log(`ZCODE_DESKTOP_INDEX=PASS session=${session.id}`)
    await client.startMonitor({ intervalMs: 2000 })
    const terminal = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("ZCode live completion timed out")), 120000)
      client.on("terminal", (event) => {
        if (event.sessionId !== session.id) return
        clearTimeout(timer)
        resolvePromise(event)
      })
    })
    const sent = await client.sendPrompt(session.id, "Reply with exactly ZCODE_HUB_E2E_OK. Do not use tools or modify files.")
    if (!sent.accepted) throw new Error("ZCode rejected the live prompt")
    const event = await terminal
    if (event.type !== "session.idle" || !event.excerpt.includes("ZCODE_HUB_E2E_OK")) throw new Error(`Unexpected ZCode response: ${event.type}`)
    console.log(`ZCODE_LIVE_SEND=PASS session=${session.id}`)
    console.log("ZCODE_LIVE_E2E=PASS")
  }
} finally {
  await client.stop().catch(() => {})
  if (testSessionId) {
    try {
      const index = new DatabaseSync(join(homedir(), ".zcode", "v2", "tasks-index.sqlite"))
      index.prepare("DELETE FROM tasks WHERE task_id = ?").run(testSessionId)
      index.close()
    } catch (error) { console.error(`ZCODE_INDEX_CLEANUP=SKIP code=${error.code || "unknown"}`) }
  }
  if (workspace) {
    try { rmSync(workspace, { recursive: true, force: true }) }
    catch (error) { console.error(`ZCODE_LIVE_CLEANUP=SKIP code=${error.code || "unknown"}`) }
  }
}
