import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { sessionIdentity } from "../app/agent-context.mjs"

// Exercise the real controller and its independent command/event loops. A task
// can complete before the HTTP request that submitted it receives its response.
async function verifyLateAcknowledgement(kind) {
  const root = mkdtempSync(join(tmpdir(), "hub-dispatch-race-"))
  for (const name of ["instances", "events", "pi-agent"]) mkdirSync(join(root, name))
  let controller
  let output = ""
  let firstResponse
  let busy = false
  const prompts = []
  const messages = []
  const updates = []
  let nextUpdate = 1
  const session = { id: "session-race", backend: "opencode", title: "Dispatch race", directory: root, status: "idle" }
  const reply = (response, body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify(body))
  }
  const server = createServer((request, response) => {
    let raw = ""
    request.on("data", (part) => { raw += part })
    request.on("end", () => {
      const url = new URL(request.url, "http://localhost")
      const body = raw ? JSON.parse(raw) : {}
      if (url.pathname.startsWith("/bot")) {
        const method = url.pathname.split("/").at(-1)
        const result = method === "getMe" ? { username: "race_test_bot" }
          : method === "getUpdates" ? updates.splice(0, 1)
            : method === "sendMessage" ? (messages.push(body), { message_id: messages.length }) : true
        reply(response, { ok: true, result })
        return
      }
      if (url.pathname.endsWith("/prompt_async")) {
        prompts.push(body.parts.map((part) => part.text).join("\n"))
        busy = true
        if (prompts.length === 1) {
          firstResponse = response
          busy = false
          writeFileSync(join(root, "events", "early-completion.json"), JSON.stringify({
            version: 1, backend: "opencode", id: "completion-first", turnId: "turn-first",
            type: "session.idle", createdAt: new Date().toISOString(), sessionId: session.id,
            title: session.title, directory: root, serverUrl: session.serverUrl, excerpt: "first is complete",
          }))
        } else {
          reply(response, {}, 204)
          // The second dispatch must be acknowledged before the first fails.
          setTimeout(() => {
            if (kind === "disconnect") firstResponse.destroy()
            else reply(firstResponse, { error: "late rejection" }, 400)
          }, 100)
        }
        return
      }
      if (url.pathname === "/session/status") reply(response, { [session.id]: { type: busy ? "busy" : "idle" } })
      else if (url.pathname === "/session") reply(response, [{ ...session, time: { updated: Date.now() } }])
      else reply(response, [])
    })
  })
  const state = () => JSON.parse(readFileSync(join(root, "state.json"), "utf8"))
  const logs = () => {
    try { return readdirSync(join(root, "logs")).map((name) => readFileSync(join(root, "logs", name), "utf8")).join("\n") }
    catch { return "" }
  }
  const waitFor = async (condition, label) => {
    for (let index = 0; index < 160; index += 1) {
      if (condition()) return
      if (controller?.exitCode != null) throw new Error(`Controller exited during ${label}: ${output.slice(-2000)}`)
      await sleep(100)
    }
    throw new Error(`Timed out during ${label}: ${output.slice(-1000)}\n${logs().slice(-3000)}\nprompts=${JSON.stringify(prompts)} messages=${JSON.stringify(messages)}`)
  }
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done))
    session.serverUrl = `http://127.0.0.1:${server.address().port}`
    writeFileSync(join(root, "instances", "test.json"), JSON.stringify({ ...session, instanceId: "test", pid: process.pid, updatedAt: new Date().toISOString() }))
    writeFileSync(join(root, "config.json"), JSON.stringify({ version: 4, language: "en", botTokenProtected: "test", allowedUserId: "900001", allowedChatId: "900001" }))
    writeFileSync(join(root, "state.json"), JSON.stringify({ selected: session, sessionMap: [session], viewMode: "agent", activeBackend: "opencode", updateOffset: 0 }))
    controller = spawn(process.execPath, [resolve("app/controller.mjs")], {
      cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: root, AGENT_TASK_HUB_CONFIG: join(root, "config.json"),
        AGENT_TASK_HUB_BOT_TOKEN: "123:LOCAL_TEST", AGENT_TASK_HUB_TELEGRAM_API_ROOT: session.serverUrl,
        AGENT_TASK_HUB_CODEX_COMMAND: join(root, "missing-codex.exe"), AGENT_TASK_HUB_ZCODE_BUNDLE: join(root, "missing-zcode.js"),
        AGENT_TASK_HUB_PI_AGENT_DIR: join(root, "pi-agent") },
    })
    controller.stdout.on("data", (chunk) => { output += String(chunk) })
    controller.stderr.on("data", (chunk) => { output += String(chunk) })
    updates.push({ update_id: nextUpdate++, message: { message_id: 1, date: Math.floor(Date.now() / 1000),
      chat: { id: 900001, type: "private" }, from: { id: 900001 }, text: "/batch first instruction\n---\nsecond instruction" } })
    await waitFor(() => logs().includes("Late dispatch response ignored"), `late ${kind} processed`)
    const key = sessionIdentity(session)
    const current = state()
    assert.deepEqual(prompts, ["first instruction", "second instruction"])
    assert.equal(current.queueInFlight[key].text, "second instruction", "late failure must not erase the new active item")
    assert.equal(current.queueInFlight[key].dispatchState, "sent")
    assert.equal(Boolean(current.queuePaused[key]), false, "late failure must not pause the new task")
    assert.deepEqual(current.queues[key], [], "completed first instruction must not return to the queue")
    assert.ok(current.processedEventIds.includes("completion-first"))
  } finally {
    if (controller && controller.exitCode == null) {
      const stopped = new Promise((done) => controller.once("exit", done))
      controller.kill()
      await stopped
    }
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
    rmSync(root, { recursive: true, force: true })
  }
}

await verifyLateAcknowledgement("disconnect")
await verifyLateAcknowledgement("reject")
console.log("DISPATCH_RACE_TEST=PASS")
