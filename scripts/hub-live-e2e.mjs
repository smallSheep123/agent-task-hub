import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAppServer } from "../adapters/codex-app-server.mjs"

if (process.env.AGENT_TASK_HUB_LIVE_E2E !== "1") {
  throw new Error("Set AGENT_TASK_HUB_LIVE_E2E=1 to run the model-backed Hub test")
}

const root = await mkdtemp(join(tmpdir(), "agent-task-hub-live-e2e-"))
const token = "123456789:TEST_TOKEN_FOR_LOCAL_E2E_ONLY"
const userId = 900001
const chatId = 900001
const wsUrl = process.env.AGENT_TASK_HUB_CODEX_WS_URL || "ws://127.0.0.1:9234"
const projectDir = process.env.AGENT_TASK_HUB_E2E_CWD || process.cwd()
const timeoutMs = Number(process.env.AGENT_TASK_HUB_E2E_TIMEOUT_MS || 900000)
const commands = [
  "/new e2e | Reply exactly HUB_QUEUE_ONE. Do not use tools or change files.",
  "/add Reply exactly HUB_QUEUE_TWO. Do not use tools or change files.",
  "/batch Reply exactly HUB_QUEUE_THREE. Do not use tools or change files.\n---\nReply exactly HUB_QUEUE_FOUR. Do not use tools or change files.",
  "/queue",
  "/current",
  "/show",
  "/sessions",
]
const sentMessages = []
let updateIndex = 0
let messageId = 1000
let controller = null
let threadId = null
let serverClosed = false

function json(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

const server = createServer((request, response) => {
  let raw = ""
  request.setEncoding("utf8")
  request.on("data", (chunk) => { raw += chunk })
  request.on("end", () => {
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch {}
    const method = String(request.url || "").split("/").at(-1)
    if (method === "getMe") return json(response, { ok: true, result: { id: 999001, is_bot: true, username: "agent_task_hub_e2e_bot" } })
    if (method === "setMyCommands" || method === "answerCallbackQuery" || method === "editMessageText" || method === "editMessageReplyMarkup") return json(response, { ok: true, result: true })
    if (method === "sendMessage") {
      sentMessages.push(body)
      const preview = String(body.text || "").replace(/\s+/g, " ").slice(0, 120)
      console.log(`HUB_LIVE_E2E_MESSAGE=${sentMessages.length} ${preview}`)
      return json(response, { ok: true, result: { message_id: messageId++, chat: { id: chatId, type: "private" }, text: body.text || "" } })
    }
    if (method === "getUpdates") {
      if (updateIndex >= commands.length) return json(response, { ok: true, result: [] })
      const updateId = 700000 + updateIndex
      const text = commands[updateIndex++]
      console.log(`HUB_LIVE_E2E_UPDATE=${updateIndex}/${commands.length}`)
      return json(response, { ok: true, result: [{
        update_id: updateId,
        message: {
          message_id: 5000 + updateIndex,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
          from: { id: userId, is_bot: false, first_name: "E2E" },
          text,
        },
      }] })
    }
    return json(response, { ok: false, description: `Unsupported mock method ${method}` })
  })
})

const listen = () => new Promise((resolve, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", resolve)
})
const closeServer = () => new Promise((resolve) => {
  if (serverClosed) return resolve()
  serverClosed = true
  server.close(() => resolve())
})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await listen()
  const address = server.address()
  const apiRoot = `http://127.0.0.1:${address.port}`
  await writeFile(join(root, "config.json"), JSON.stringify({
    version: 4,
    product: "agent-task-hub",
    language: "en-US",
    botUsername: "agent_task_hub_e2e_bot",
    botTokenProtected: "test-only-placeholder",
    allowedUserId: String(userId),
    allowedChatId: String(chatId),
    maxSessions: 100,
    sessionPageSize: 6,
    queueLimit: 20,
    openCodePollIntervalMs: 5000,
    codexTransport: "shared",
    codexWsUrl: wsUrl,
    codexPollIntervalMs: 2000,
    codexMonitorLimit: 100,
    codexProjects: { e2e: projectDir },
  }, null, 2), "utf8")
  await writeFile(join(root, "state.json"), JSON.stringify({ updateOffset: 0, selected: null, sessionMap: [], viewMode: "global", activeBackend: null }, null, 2), "utf8")

  controller = spawn(process.execPath, ["app/controller.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_TASK_HUB_DATA_DIR: root,
      AGENT_TASK_HUB_CONFIG: join(root, "config.json"),
      AGENT_TASK_HUB_BOT_TOKEN: token,
      AGENT_TASK_HUB_TELEGRAM_API_ROOT: apiRoot,
      AGENT_TASK_HUB_CODEX_TRANSPORT: "shared",
      AGENT_TASK_HUB_CODEX_WS_URL: wsUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let childOutput = ""
  controller.stdout.on("data", (chunk) => { childOutput += String(chunk) })
  controller.stderr.on("data", (chunk) => { childOutput += String(chunk) })

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const allDone = sentMessages.some((message) => /queue for .* is complete/i.test(String(message.text || "")))
    const sessionsDone = sentMessages.some((message) => /All agent sessions/i.test(String(message.text || "")))
    if (allDone && sessionsDone) break
    if (controller.exitCode !== null) throw new Error(`Controller exited early (${controller.exitCode}): ${childOutput.slice(-1000)}`)
    await delay(500)
  }
  assert.ok(sentMessages.some((message) => /queue for .* is complete/i.test(String(message.text || ""))), "queue did not finish before timeout")
  assert.ok(sentMessages.some((message) => /All agent sessions/i.test(String(message.text || ""))), "sessions command did not finish before timeout")

  const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"))
  threadId = state.selected?.id || null
  assert.equal(state.selected?.backend, "codex")
  assert.ok(threadId)
  const key = `codex:codex-local:${threadId}`
  assert.equal((state.queues?.[key] || []).length, 0)
  assert.equal(state.queueInFlight?.[key], undefined)
  assert.ok(sentMessages.some((message) => /Created and started a Codex session/i.test(String(message.text || ""))))
  assert.ok(sentMessages.some((message) => /Added one prompt.*Session status: busy/is.test(String(message.text || ""))))
  assert.ok(sentMessages.some((message) => /Accepted 2 prompts/i.test(String(message.text || ""))))
  assert.ok(sentMessages.some((message) => /Queue mode:/i.test(String(message.text || ""))))
  assert.ok(sentMessages.some((message) => String(message.text || "").includes("Agent:") && String(message.text || "").includes("Codex")))
  assert.ok(sentMessages.some((message) => String(message.text || "").includes("Status:") && String(message.text || "").includes("busy")))
  assert.ok(sentMessages.some((message) => /All agent sessions/i.test(String(message.text || ""))))
  assert.ok(sentMessages.some((message) => /queue for .*HUB\\_QUEUE\\_ONE.* is complete/is.test(String(message.text || ""))), "new thread title was not preserved in queue completion")

  const completionMessages = sentMessages.filter((message) => /task completed/i.test(String(message.text || "")) && /Codex/i.test(String(message.text || "")))
  assert.ok(completionMessages.length >= 4, `expected 4 completion messages, got ${completionMessages.length}`)
  assert.ok(completionMessages.every((message) => !/task completed\*\s+Codex task(?:\s|\*)/i.test(String(message.text || ""))), "a completion notification downgraded to the generic Codex task title")

  const client = new CodexAppServer({ transport: "shared", wsUrl })
  try {
    await client.start()
    const thread = await client.readThread(threadId)
    assert.ok((thread.turns || []).filter((turn) => turn.status === "completed").length >= 4)
    await client.archiveThread(threadId)
  } finally {
    await client.stop().catch(() => {})
  }
  threadId = null

  console.log(`HUB_LIVE_E2E=PASS ${JSON.stringify({ updates: updateIndex, messages: sentMessages.length, completions: completionMessages.length })}`)
} catch (error) {
  console.error(`HUB_LIVE_E2E=FAIL ${error?.stack || error}`)
  process.exitCode = 1
} finally {
  if (controller && controller.exitCode === null) {
    const exited = new Promise((resolve) => controller.once("exit", resolve))
    controller.kill()
    await Promise.race([exited, delay(3000)])
  }
  if (threadId) {
    const cleanup = new CodexAppServer({ transport: "shared", wsUrl })
    try {
      await cleanup.start()
      await cleanup.interrupt(threadId).catch(() => {})
      await delay(300)
      await cleanup.archiveThread(threadId).catch(() => {})
    } catch {} finally {
      await cleanup.stop().catch(() => {})
    }
  }
  await closeServer()
  await rm(root, { recursive: true, force: true })
  setTimeout(() => process.exit(process.exitCode || 0), 50)
}
