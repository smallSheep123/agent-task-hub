import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

const root = process.env.AGENT_TASK_HUB_DATA_DIR || join(homedir(), ".config", "agent-task-hub")
const piRoot = join(root, "pi")
const instanceId = randomBytes(6).toString("hex")
const instancePath = join(piRoot, "instances", `${instanceId}.json`)
const inbox = join(piRoot, "inbox", instanceId)
const replies = join(piRoot, "replies", instanceId)
const events = join(root, "events")
const history = join(piRoot, "history")

const retryableRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function atomicJson(path, value, { renameFile = renameSync, wait = pause } = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
    for (let attempt = 0; ; attempt += 1) {
      try { renameFile(temp, path); return }
      catch (error) {
        if (!retryableRenameCodes.has(error?.code) || attempt >= 7) throw error
        wait(Math.min(15 * (attempt + 1), 60))
      }
    }
  } finally { try { rmSync(temp, { force: true }) } catch {} }
}

function assistantText(message) {
  return (message?.content || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n")
}

export default function piAgentTaskHub(pi) {
  let context = null
  let timer = null
  let busy = false
  let startedAt = null
  let latestReply = ""
  let latestError = null
  let runId = null
  let lastFinishedAt = null
  let lastRunId = null
  let lastWarningAt = 0
  let lastHeartbeatAt = 0
  const pendingEvents = []

  const reportError = (error) => {
    if (Date.now() - lastWarningAt < 60000) return
    lastWarningAt = Date.now()
    console.error(`[Agent Task Hub] Pi bridge I/O failed (${error?.code || "unknown"}); Pi will keep running.`)
  }
  const safe = (action) => { try { return action() } catch (error) { reportError(error); return false } }

  const identity = () => ({
    sessionId: context?.sessionManager?.getSessionId?.() || "",
    sessionFile: context?.sessionManager?.getSessionFile?.() || null,
    title: context?.sessionManager?.getSessionName?.() || `Pi · ${basename(context?.cwd || process.cwd())}`,
    directory: context?.cwd || process.cwd(),
    model: context?.model ? `${context.model.provider}/${context.model.id}` : null,
    thinkingLevel: context?.thinkingLevel || null,
  })
  const heartbeat = () => {
    if (!context) return
    lastHeartbeatAt = Date.now()
    atomicJson(instancePath, { instanceId, processId: process.pid, workerId: process.env.AGENT_TASK_HUB_WORKER_ID || null, ...identity(),
      status: busy ? "busy" : "idle", startedAt, updatedAt: new Date().toISOString(),
      latestReply, lastError: latestError, lastFinishedAt, lastRunId })
  }
  const rememberSession = () => {
    if (!context) return
    const item = identity()
    if (!item.sessionFile || !item.sessionId) return
    const key = createHash("sha256").update(item.sessionFile.toLowerCase()).digest("hex").slice(0, 24)
    atomicJson(join(history, `${key}.json`), { ...item, lastSeenAt: new Date().toISOString() })
  }
  const processInbox = async () => {
    if (!context || !existsSync(inbox)) return
    for (const name of readdirSync(inbox).filter((value) => /^[0-9a-f-]{36}\.json$/.test(value)).slice(0, 20)) {
      const path = join(inbox, name)
      let command
      try { command = JSON.parse(readFileSync(path, "utf8")) } catch { rmSync(path, { force: true }); continue }
      rmSync(path, { force: true })
      let reply = { ok: false, error: "Unsupported Pi command" }
      try {
        if (command.sessionId !== identity().sessionId) throw new Error("Pi session changed")
        if (command.type === "send") {
          if (!String(command.text || "").trim()) throw new Error("Empty prompt")
          await pi.sendUserMessage(String(command.text), busy ? { deliverAs: "followUp" } : undefined)
          reply = { ok: true, queued: busy }
        } else if (command.type === "abort") {
          context.abort()
          reply = { ok: true }
        }
      } catch (error) { reply = { ok: false, error: String(error?.message || error) } }
      atomicJson(join(replies, name), reply)
    }
  }

  const flushEvents = () => {
    while (pendingEvents.length) {
      const item = pendingEvents[0]
      atomicJson(item.path, item.value)
      pendingEvents.shift()
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    context = ctx
    busy = false; startedAt = null; runId = null; latestReply = ""; latestError = null
    safe(() => mkdirSync(inbox, { recursive: true }))
    safe(() => mkdirSync(replies, { recursive: true }))
    safe(heartbeat)
    safe(rememberSession)
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      if (Date.now() - lastHeartbeatAt >= 3000) safe(heartbeat)
      safe(flushEvents)
      void processInbox().catch(reportError)
    }, 750)
    timer.unref?.()
  })
  pi.on("session_info_changed", async (_event, ctx) => { context = ctx; safe(heartbeat); safe(rememberSession) })
  pi.on("agent_start", async (_event, ctx) => {
    context = ctx; busy = true; startedAt = new Date().toISOString(); runId = randomUUID()
    latestReply = ""; latestError = null; safe(heartbeat)
  })
  pi.on("message_end", async (event) => {
    if (event.message?.role !== "assistant") return
    latestReply = assistantText(event.message) || latestReply
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") latestError = event.message.errorMessage || event.message.stopReason
  })
  pi.on("agent_settled", async (_event, ctx) => {
    context = ctx
    if (!runId) return
    const current = runId
    runId = null
    busy = false
    lastFinishedAt = new Date().toISOString()
    lastRunId = current
    safe(heartbeat)
    safe(rememberSession)
    const item = { version: 1, backend: "pi", instanceId, id: `pi:${instanceId}:${current}`,
      turnId: current, type: latestError ? "session.error" : "session.idle",
      createdAt: new Date().toISOString(), sessionId: identity().sessionId,
      title: identity().title, directory: identity().directory, excerpt: latestReply, error: latestError }
    pendingEvents.push({ path: join(events, `${Date.now()}-${randomUUID()}.json`), value: item })
    safe(flushEvents)
  })
  pi.on("session_shutdown", async () => {
    safe(rememberSession)
    safe(flushEvents)
    if (timer) clearInterval(timer)
    timer = null; context = null
    safe(() => rmSync(instancePath, { force: true }))
  })
}
