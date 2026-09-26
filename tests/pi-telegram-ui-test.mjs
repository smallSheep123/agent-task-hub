import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const root = mkdtempSync(join(tmpdir(), "hub-pi-ui-"))
const agentDir = join(root, "pi-agent")
const sessionsDir = join(agentDir, "sessions", "--test-project--")
mkdirSync(sessionsDir, { recursive: true })
const projectDir = join(root, "project")
mkdirSync(projectDir)
const saved = [
  { id: "12345678-1234-1234-1234-123456789abc", prompt: "Inspect the browser automation results", name: "Browser project" },
  { id: "12345678-1234-1234-1234-123456789abd", prompt: "Explain why the second experiment failed", name: "" },
]
for (const [index, session] of saved.entries()) {
  const lines = [
    { type: "session", version: 3, id: session.id, cwd: projectDir, timestamp: new Date(Date.now() - (index + 1) * 1000).toISOString() },
    { type: "message", id: `user-${index}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: session.prompt }] } },
  ]
  if (session.name) lines.push({ type: "session_info", name: session.name })
  writeFileSync(join(sessionsDir, `${session.id}.jsonl`), `${lines.map((item) => JSON.stringify(item)).join("\n")}\n`)
}
writeFileSync(join(root, "config.json"), JSON.stringify({
  version: 4, product: "agent-task-hub", language: "zh-CN", botUsername: "pi_test_bot",
  botTokenProtected: "test", allowedUserId: "900001", allowedChatId: "900001", sessionPageSize: 6,
}))
writeFileSync(join(root, "state.json"), JSON.stringify({ updateOffset: 0, selected: null, sessionMap: [], viewMode: "global", activeBackend: null }))

const updates = []
const sent = []
let nextUpdate = 1000
let controller
let output = ""
const server = createServer((request, response) => {
  let raw = ""
  request.on("data", (chunk) => { raw += chunk })
  request.on("end", () => {
    const method = String(request.url || "").split("/").at(-1)
    const body = raw ? JSON.parse(raw) : {}
    const result = method === "getMe" ? { id: 1, username: "pi_test_bot" }
      : method === "getUpdates" ? updates.splice(0, 1)
        : method === "sendMessage" ? (sent.push(body), { message_id: sent.length, text: body.text }) : true
    const text = JSON.stringify({ ok: true, result })
    response.writeHead(200, { "content-type": "application/json" })
    response.end(text)
  })
})
const waitFor = async (condition, description) => {
  for (let i = 0; i < 200; i += 1) {
    const result = condition()
    if (result) return result
    if (controller?.exitCode != null) throw new Error(`Controller exited: ${output.slice(-1000)}`)
    await sleep(100)
  }
  throw new Error(`Timed out: ${description}; ${output.slice(-1000)}; messages=${JSON.stringify(sent.map((item) => ({ text: String(item.text).slice(0, 250), buttons: item.reply_markup?.inline_keyboard?.map((row) => row.map((button) => button.callback_data)) })))}`)
}

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  controller = spawn(process.execPath, [resolve("app/controller.mjs")], {
    cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: root, AGENT_TASK_HUB_CONFIG: join(root, "config.json"),
      AGENT_TASK_HUB_BOT_TOKEN: "123:LOCAL_TEST", AGENT_TASK_HUB_TELEGRAM_API_ROOT: `http://127.0.0.1:${server.address().port}`,
      AGENT_TASK_HUB_PI_AGENT_DIR: agentDir, AGENT_TASK_HUB_CODEX_COMMAND: "missing-test-command" },
  })
  controller.stdout.on("data", (chunk) => { output += String(chunk) })
  controller.stderr.on("data", (chunk) => { output += String(chunk) })
  const user = { id: 900001, is_bot: false, first_name: "Test" }
  updates.push({ update_id: nextUpdate++, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/pi" } })
  const list = await waitFor(() => sent.find((item) => String(item.text).includes("Browser project") && String(item.text).includes("Explain why")), "Pi list")
  const clean = String(list.text).replaceAll("\\", "")
  assert.match(clean, /Browser project[^\n]*\n📁 /)
  assert.match(clean, /Explain why the second experiment failed[^\n]*\n📁 /)
  assert.match(clean, /⚪/)
  const select = list.reply_markup.inline_keyboard.flat().find((item) => String(item.callback_data || "").startsWith("select:p:"))
  assert.ok(select)
  updates.push({ update_id: nextUpdate++, callback_query: { id: "pick-1", from: user, data: select.callback_data,
    message: { message_id: 2, chat: { id: 900001, type: "private" } } } })
  const detail = await waitFor(() => sent.find((item) => String(item.text).includes("已关闭") && item.reply_markup?.inline_keyboard?.flat().some((button) => String(button.callback_data || "").startsWith("pirestore:p:"))), "closed Pi details")
  assert.match(String(detail.text), /首条提问/)
  assert.ok(Buffer.byteLength(detail.reply_markup.inline_keyboard[0][0].callback_data) <= 64)
  console.log("PI_TELEGRAM_UI_TEST=PASS")
} finally {
  controller?.kill()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await sleep(250)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
