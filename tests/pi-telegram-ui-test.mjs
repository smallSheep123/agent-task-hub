import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { telegramTextParts } from "../app/telegram-long-text.mjs"

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
const piPrompts = []
let failAcknowledgement = ""
let failedAcknowledgements = 0
let piHandlers = null
let nextUpdate = 1000
let controller
let output = ""
const startController = () => {
  controller = spawn(process.execPath, [resolve("app/controller.mjs")], {
    cwd: resolve("."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: root, AGENT_TASK_HUB_CONFIG: join(root, "config.json"),
      AGENT_TASK_HUB_BOT_TOKEN: "123:LOCAL_TEST", AGENT_TASK_HUB_TELEGRAM_API_ROOT: `http://127.0.0.1:${server.address().port}`,
      AGENT_TASK_HUB_PI_AGENT_DIR: agentDir, AGENT_TASK_HUB_CODEX_COMMAND: "missing-test-command" },
  })
  controller.stdout.on("data", (chunk) => { output += String(chunk) })
  controller.stderr.on("data", (chunk) => { output += String(chunk) })
}
const stopController = async () => {
  if (!controller || controller.exitCode != null) return
  const stopped = new Promise((done) => controller.once("exit", done))
  controller.kill()
  await stopped
}
const server = createServer((request, response) => {
  let raw = ""
  request.on("data", (chunk) => { raw += chunk })
  request.on("end", () => {
    const method = String(request.url || "").split("/").at(-1)
    const body = raw ? JSON.parse(raw) : {}
    if (method === "sendMessage" && failAcknowledgement && String(body.text).includes(failAcknowledgement)) {
      failAcknowledgement = ""
      failedAcknowledgements += 1
      request.socket.destroy()
      return
    }
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
  startController()
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
  updates.push({ update_id: nextUpdate++, message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/send" } })
  await waitFor(() => sent.find((item) => String(item.text).includes("/send 指令内容")), "Pi send usage")

  const fullReply = `决定性的证据。\n${"逐页检查，不要跳过中间页。\n".repeat(450)}`
  const completion = `✅ [Pi] 任务已完成\nBrowser project\n目录：${projectDir}\n来源：电脑端手动任务\n\n最近回复：\n${fullReply}`
  const expectedParts = telegramTextParts(completion, { language: "zh-CN" })
  assert.ok(expectedParts.length > 1)
  writeFileSync(join(root, "events", "pi-long-reply.json"), JSON.stringify({
    version: 1, backend: "pi", instanceId: "123456789abc", id: "pi:123456789abc:test-turn",
    turnId: "test-turn", type: "session.idle", createdAt: new Date().toISOString(),
    sessionId: saved[0].id, title: "Browser project", directory: projectDir, excerpt: fullReply,
  }))
  await waitFor(() => sent.filter((item) => String(item.text).startsWith("第 ")).length === expectedParts.length, "full Pi completion")
  const delivered = sent.filter((item) => String(item.text).startsWith("第 "))
  assert.equal(delivered.map((item) => String(item.text).slice(String(item.text).indexOf("\n") + 1)).join(""), completion.trim())
  assert.ok(delivered.at(-1).reply_markup?.inline_keyboard?.flat().some((button) => String(button.callback_data || "").startsWith("sendhelp:p:")))

  process.env.AGENT_TASK_HUB_DATA_DIR = root
  const { default: piExtension } = await import("../adapters/pi-extension.js")
  piHandlers = new Map()
  piExtension({ on: (name, handler) => piHandlers.set(name, handler), sendUserMessage: async (value) => { piPrompts.push(value) } })
  const liveFile = join(sessionsDir, `${saved[0].id}.jsonl`)
  const piContext = {
    cwd: projectDir, model: { provider: "test", id: "model" }, thinkingLevel: "low",
    sessionManager: { getSessionId: () => saved[0].id, getSessionFile: () => liveFile, getSessionName: () => saved[0].name },
    abort: () => {},
  }
  await piHandlers.get("session_start")({}, piContext)
  const { listPiSessions } = await import("../adapters/pi-bridge.mjs")
  const [live] = listPiSessions(root)
  await sleep(8500)
  updates.push({ update_id: nextUpdate++, message: { message_id: 4, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/pi" } })
  const liveList = await waitFor(() => sent.find((item) => item.reply_markup?.inline_keyboard?.flat().some((button) => String(button.callback_data || "").includes(live.instanceId))), "live Pi list")
  const liveSelect = liveList.reply_markup.inline_keyboard.flat().find((button) => String(button.callback_data || "").startsWith(`select:p:${live.instanceId}.`))
  assert.ok(liveSelect)
  updates.push({ update_id: nextUpdate++, callback_query: { id: "pick-live", from: user, data: liveSelect.callback_data,
    message: { message_id: 5, chat: { id: 900001, type: "private" } } } })
  await waitFor(() => sent.find((item) => String(item.text).includes("已进入 Pi 模式")), "live Pi selection")
  failAcknowledgement = "已追加并开始执行"
  updates.push({ update_id: nextUpdate++, message: { message_id: 6, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/add First queued task" } })
  await waitFor(() => piPrompts.length === 1 && failedAcknowledgements === 1, "Pi add dispatched despite failed acknowledgement")
  assert.deepEqual(piPrompts, ["First queued task"])
  failAcknowledgement = "已追加 1 条指令"
  updates.push({ update_id: nextUpdate++, message: { message_id: 7, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/send Second queued task" } })
  await waitFor(() => failedAcknowledgements === 2, "Pi send queued despite failed acknowledgement")
  updates.push({ update_id: nextUpdate++, message: { message_id: 8, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/queue" } })
  const queueState = await waitFor(() => sent.find((item) => String(item.text).includes("First queued task") && String(item.text).includes("Second queued task")), "Pi queue after acknowledgement failures")
  assert.ok(queueState)
  assert.equal(sent.some((item) => String(item.text).includes("操作失败")), false)
  // Completing a task must advance its queue even while Telegram cannot send the notice.
  const completionEvent = { version: 1, backend: "pi", instanceId: live.instanceId,
    id: "queue-first-complete", turnId: "queue-first-run", type: "session.idle",
    createdAt: new Date().toISOString(), sessionId: live.id, title: "Browser project", directory: projectDir,
    excerpt: "QueueCompletionNetworkTest" }
  failAcknowledgement = "QueueCompletionNetworkTest"
  writeFileSync(join(root, "events", "queue-complete.json"), JSON.stringify(completionEvent))
  await waitFor(() => piPrompts.length === 2 && failedAcknowledgements === 3, "queue advances while completion notice fails")
  assert.deepEqual(piPrompts, ["First queued task", "Second queued task"])
  await waitFor(() => Object.values(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).queueInFlight).some(item => item.text === "Second queued task" && item.dispatchState === "sent"), "second task acknowledgement persisted")
  const persisted = JSON.parse(readFileSync(join(root, "state.json"), "utf8"))
  assert.ok(persisted.processedEventIds.includes(completionEvent.id))
  assert.equal(Object.values(persisted.queueInFlight).find(item => item.text === "Second queued task")?.dispatchState, "sent")
  const outbox = JSON.parse(readFileSync(join(root, "events", "queue-complete.json"), "utf8"))
  assert.equal(outbox.completionApplied, true)
  assert.ok(outbox.nextAttemptAt)
  writeFileSync(join(root, "events", "queue-duplicate.json"), JSON.stringify(completionEvent))
  await sleep(1800)
  assert.deepEqual(piPrompts, ["First queued task", "Second queued task"], "duplicate completion must not resubmit either prompt")
  await waitFor(() => sent.some(item => String(item.text).includes("QueueCompletionNetworkTest")), "persisted completion is retried")

  // Restart only the isolated fixture with an old Pi instance and keep the
  // current sent task running. Review must not replay either old or new work.
  await piHandlers.get("agent_start")({}, piContext)
  await stopController()
  const stateFile = join(root, "state.json")
  const reviewState = JSON.parse(readFileSync(stateFile, "utf8"))
  const currentKey = `pi:${live.instanceId}:${live.id}`
  const oldKey = `pi:aaaaaaaaaaaa:${live.id}`
  const currentTask = structuredClone(reviewState.queueInFlight[currentKey])
  reviewState.queues[oldKey] = [{ id: "old-waiting", text: "Waiting after old process closed", createdAt: "2026-09-27T00:00:00Z" }]
  reviewState.queueInFlight[oldKey] = { id: "old-uncertain", text: "Old attempt needing review", dispatchState: "sent", dispatchedAt: "2026-09-27T00:00:00Z" }
  reviewState.queueStartOnIdle[oldKey] = true
  writeFileSync(stateFile, JSON.stringify(reviewState))
  const firstReviewMessage = sent.length
  startController()
  updates.push({ update_id: nextUpdate++, message: { message_id: 20, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/queue" } })
  const reviewQueue = await waitFor(() => sent.slice(firstReviewMessage).find((item) => item.reply_markup?.inline_keyboard?.flat().some((button) => String(button.callback_data).startsWith("qreview:"))), "migrated Pi queue review button")
  assert.match(String(reviewQueue.text), /Waiting after old process closed/)
  const reviewButton = reviewQueue.reply_markup.inline_keyboard.flat().find((button) => button.callback_data.startsWith("qreview:"))
  const click = (data, label) => updates.push({ update_id: nextUpdate++, callback_query: { id: label, from: user, data,
    message: { message_id: nextUpdate, chat: { id: 900001, type: "private" } } } })
  click(reviewButton.callback_data, "review-old-queue")
  const confirmMessage = await waitFor(() => sent.slice(firstReviewMessage).find((item) => item.reply_markup?.inline_keyboard?.flat().some((button) => String(button.callback_data).startsWith("qconfirm:"))), "old queue confirmation screen")
  assert.match(String(confirmMessage.text), /Old attempt needing review/)
  assert.match(String(confirmMessage.text), /不会重新执行/)
  const confirmButton = confirmMessage.reply_markup.inline_keyboard.flat().find((button) => button.callback_data.startsWith("qconfirm:"))
  click(confirmButton.callback_data, "confirm-old-queue")
  await waitFor(() => sent.slice(firstReviewMessage).some((item) => String(item.text).includes("旧任务已归档")), "old queue archived")
  const confirmedState = JSON.parse(readFileSync(stateFile, "utf8"))
  assert.deepEqual(confirmedState.queueInFlight[currentKey], currentTask, "confirmation cannot delete the current sent task")
  assert.equal(confirmedState.piQueueRecovery[currentKey], undefined)
  assert.equal(confirmedState.queueInFlight[oldKey], undefined)
  assert.deepEqual(confirmedState.queues[currentKey].map((item) => item.text), ["Waiting after old process closed"])
  assert.equal(confirmedState.queuePaused[currentKey], true)
  assert.equal(confirmedState.queueStartOnIdle[currentKey], false)
  assert.equal(confirmedState.queueUncertaintyHistory.filter((entry) => entry.item.id === "old-uncertain").length, 1)
  assert.deepEqual(piPrompts, ["First queued task", "Second queued task"])

  // After new waiting work is appended, stale review and duplicate confirm
  // callbacks cannot clear it or trigger execution.
  updates.push({ update_id: nextUpdate++, message: { message_id: 21, date: Math.floor(Date.now() / 1000), chat: { id: 900001, type: "private" }, from: user, text: "/add New task after review" } })
  await waitFor(() => JSON.parse(readFileSync(stateFile, "utf8")).queues[currentKey].some((item) => item.text === "New task after review"), "new work queued while paused")
  const beforeOldClicks = sent.length
  click(reviewButton.callback_data, "stale-review-old-queue")
  click(confirmButton.callback_data, "repeat-confirm-old-queue")
  await waitFor(() => sent.slice(beforeOldClicks).filter((item) => String(item.text).includes("队列已变化或按钮已过期")).length === 2, "stale and duplicate buttons rejected")
  const afterOldClicks = JSON.parse(readFileSync(stateFile, "utf8"))
  assert.deepEqual(afterOldClicks.queueInFlight[currentKey], currentTask)
  assert.deepEqual(afterOldClicks.queues[currentKey].map((item) => item.text), ["Waiting after old process closed", "New task after review"])
  assert.equal(afterOldClicks.queueUncertaintyHistory.length, confirmedState.queueUncertaintyHistory.length)
  assert.equal(afterOldClicks.queuePaused[currentKey], true)
  assert.deepEqual(piPrompts, ["First queued task", "Second queued task"])
  console.log("PI_TELEGRAM_UI_TEST=PASS")
} finally {
  await piHandlers?.get("session_shutdown")?.()
  controller?.kill()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await sleep(250)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
