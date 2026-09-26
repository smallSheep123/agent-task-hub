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

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
  renameSync(temp, path)
}

function assistantText(message) {
  return (message?.content || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").slice(0, 1800)
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
    atomicJson(instancePath, { instanceId, processId: process.pid, ...identity(),
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

  pi.on("session_start", async (_event, ctx) => {
    context = ctx
    busy = false; startedAt = null; runId = null; latestReply = ""; latestError = null
    mkdirSync(inbox, { recursive: true })
    mkdirSync(replies, { recursive: true })
    heartbeat()
    rememberSession()
    if (timer) clearInterval(timer)
    timer = setInterval(() => { heartbeat(); void processInbox() }, 750)
    timer.unref?.()
  })
  pi.on("session_info_changed", async (_event, ctx) => { context = ctx; heartbeat(); rememberSession() })
  pi.on("agent_start", async (_event, ctx) => {
    context = ctx; busy = true; startedAt = new Date().toISOString(); runId = randomUUID()
    latestReply = ""; latestError = null; heartbeat()
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
    heartbeat()
    rememberSession()
    const item = { version: 1, backend: "pi", instanceId, id: `pi:${instanceId}:${current}`,
      turnId: current, type: latestError ? "session.error" : "session.idle",
      createdAt: new Date().toISOString(), sessionId: identity().sessionId,
      title: identity().title, directory: identity().directory, excerpt: latestReply, error: latestError }
    atomicJson(join(events, `${Date.now()}-${randomUUID()}.json`), item)
  })
  pi.on("session_shutdown", async () => {
    rememberSession()
    if (timer) clearInterval(timer)
    timer = null; context = null
    rmSync(instancePath, { force: true })
  })
}
