import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readdirSync, statSync } from "node:fs"
import { delimiter, dirname, extname, join } from "node:path"
import readline from "node:readline"

const CODEX_INSTANCE_ID = "codex-local"

function executableCandidates(command) {
  if (/[\\/]/.test(command)) return [command]
  const extensions = process.platform === "win32" ? [".exe", ".ps1", ".cmd", ""] : [""]
  return String(process.env.PATH || "").split(delimiter).flatMap((dir) => extensions.map((extension) => join(dir, command + extension)))
}

function desktopCodexExecutable() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return null
  const root = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin")
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "codex.exe"))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || null
  } catch {
    return null
  }
}

export function resolveCodexLaunch(command = "codex") {
  const requested = String(command || "codex")
  const desktop = requested.toLowerCase() === "codex" ? desktopCodexExecutable() : null
  if (desktop) return { command: desktop, args: ["app-server", "--stdio"] }
  const resolved = executableCandidates(requested).find((candidate) => existsSync(candidate)) || requested
  if (process.platform !== "win32") return { command: resolved, args: ["app-server", "--stdio"] }
  const extension = extname(resolved).toLowerCase()
  if ([".ps1", ".cmd", ".bat"].includes(extension)) {
    const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
    const platformPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64"
    const npmRoot = dirname(resolved)
    const nativeCandidates = [
      join(npmRoot, "node_modules", "@openai", "codex", "node_modules", "@openai", platformPackage, "vendor", target, "bin", "codex.exe"),
      join(npmRoot, "node_modules", "@openai", "codex", "vendor", target, "bin", "codex.exe"),
    ]
    const native = nativeCandidates.find((candidate) => existsSync(candidate))
    if (native) return { command: native, args: ["app-server", "--stdio"] }
  }
  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, "app-server", "--stdio"],
    }
  }
  if (extension === ".cmd" || extension === ".bat") {
    const script = resolved.slice(0, -extension.length) + ".ps1"
    if (existsSync(script)) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "app-server", "--stdio"],
      }
    }
    const safe = resolved.replaceAll("%", "%%").replaceAll('"', '""')
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", '"' + safe + '" app-server --stdio'] }
  }
  return { command: resolved, args: ["app-server", "--stdio"] }
}

function statusText(status) {
  const value = typeof status === "string" ? status : status?.type
  if (value === "active" || value === "inProgress") return "busy"
  if (value === "systemError" || value === "failed") return "error"
  return "idle"
}

function unixMilliseconds(value) {
  let number = Number(value || 0)
  if (number > 0 && number < 1e12) number *= 1000
  return number
}

export function externalTerminalTurn(thread, { threshold = 0, observedTurns = new Set() } = {}) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const turn = turns.at(-1)
  if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return null
  // A Desktop-owned turn can be persisted temporarily as "interrupted" while
  // it is still running. Only completedAt proves that a polled external turn
  // reached a terminal state. Older terminal turns must not be reported after
  // a newer turn starts in the same thread.
  const completedAt = unixMilliseconds(turn.completedAt)
  if (!completedAt || completedAt < threshold || observedTurns.has(String(turn.id))) return null
  return turn
}

function titleForThread(thread) {
  return String(thread?.name || thread?.preview || "Codex task").split(/\r?\n/, 1)[0].trim().slice(0, 180) || "Codex task"
}

export function codexThreadToSession(thread) {
  return {
    id: String(thread.id),
    backend: "codex",
    instanceId: CODEX_INSTANCE_ID,
    title: titleForThread(thread),
    directory: String(thread.cwd || ""),
    status: statusText(thread.status),
    codexStatus: thread.status || { type: "notLoaded" },
    updatedAt: thread.updatedAt || thread.recencyAt || thread.createdAt || 0,
    activeTurnId: [...(thread.turns || [])].reverse().find((turn) => turn?.status === "inProgress")?.id || null,
  }
}

function finalText(turn, fallback = "") {
  const item = [...(turn?.items || [])].reverse().find((entry) => entry?.type === "agentMessage" || entry?.type === "exitedReviewMode")
  return String(item?.text || item?.review || fallback || "").trim().slice(0, 1800)
}

function diffSummary(turn, diff = "") {
  const paths = new Set()
  let additions = 0
  let deletions = 0
  const diffs = [diff]
  for (const item of turn?.items || []) {
    if (item?.type !== "fileChange") continue
    for (const change of item.changes || []) {
      if (change?.path) paths.add(String(change.path))
      if (change?.diff) diffs.push(String(change.diff))
    }
  }
  for (const text of diffs) {
    for (const line of String(text || "").split(/\r?\n/)) {
      if (line.startsWith("diff --git ")) paths.add(line.slice(11).split(" b/")[0].replace(/^a\//, ""))
      else if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
    }
  }
  return paths.size || additions || deletions ? { files: paths.size, additions, deletions } : null
}

export function terminalEventFromNotification(params, thread = null, cachedText = "", diff = "") {
  const turn = params?.turn || {}
  const status = String(turn.status || "failed")
  const threadId = String(params?.threadId || thread?.id || "")
  const turnId = String(turn.id || "")
  const completedAt = Number(turn.completedAt || 0)
  return {
    version: 1,
    backend: "codex",
    instanceId: CODEX_INSTANCE_ID,
    id: "codex:" + threadId + ":" + turnId,
    type: status === "completed" ? "session.idle" : status === "interrupted" ? "session.interrupted" : "session.error",
    status,
    createdAt: completedAt ? new Date(completedAt * 1000).toISOString() : new Date().toISOString(),
    sessionId: threadId,
    turnId,
    title: titleForThread(thread),
    directory: String(thread?.cwd || ""),
    summary: diffSummary(turn, diff),
    excerpt: finalText(turn, cachedText),
    error: status === "failed" ? String(turn?.error?.message || "Codex turn failed").slice(0, 1000) : null,
    durationMs: turn.durationMs ?? null,
  }
}

export function approvalOptionsForRequest(method, params = {}) {
  if (method === "item/permissions/requestApproval") {
    return [
      { action: "turn", labelKey: "allowOnce" },
      { action: "session", labelKey: "allowSession" },
      { action: "reject", labelKey: "deny" },
    ]
  }
  const decisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions.filter((value) => typeof value === "string")
    : ["accept", "acceptForSession", "decline", "cancel"]
  const supported = decisions.filter((value) => ["accept", "acceptForSession", "decline", "cancel"].includes(value))
  const safeDecisions = supported.length ? supported : ["decline", "cancel"]
  return safeDecisions.map((action) => ({
    action,
    labelKey: action === "accept" ? "allowOnce" : action === "acceptForSession" ? "allowSession" : action === "cancel" ? "cancelTask" : "deny",
  }))
}

export function approvalResponseForRequest(method, params, action) {
  if (method === "item/permissions/requestApproval") {
    if (action === "reject") return { permissions: {}, scope: "turn" }
    if (!["turn", "session"].includes(action)) throw new Error("Unsupported permission decision")
    return { permissions: params?.permissions || {}, scope: action }
  }
  if (!["accept", "acceptForSession", "decline", "cancel"].includes(action)) throw new Error("Unsupported approval decision")
  return { decision: action }
}

export class CodexAppServer extends EventEmitter {
  constructor({ command = process.env.AGENT_TASK_HUB_CODEX_COMMAND || "codex", requestTimeoutMs = 20000, spawnFactory = spawn } = {}) {
    super()
    this.command = command
    this.connectionId = randomUUID()
    this.requestTimeoutMs = requestTimeoutMs
    this.spawnFactory = spawnFactory
    this.process = null
    this.lines = null
    this.nextId = 1
    this.pending = new Map()
    this.threads = new Map()
    this.activeTurns = new Map()
    this.latestMessages = new Map()
    this.diffs = new Map()
    this.threadVersions = new Map()
    this.observedTurns = new Set()
    this.monitorTimer = null
    this.monitorBusy = false
    this.monitorStartedAt = 0
    this.monitorInitialized = false
    this.ready = false
    this.stopping = false
    this.stderr = ""
  }

  get isRunning() {
    return Boolean(this.process && this.process.exitCode === null && !this.process.killed)
  }

  async start() {
    if (this.ready && this.isRunning) return this
    this.stopping = false
    const launch = resolveCodexLaunch(this.command)
    this.process = this.spawnFactory(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    })
    this.process.on("error", (error) => this.#fail(error))
    this.process.on("exit", (code, signal) => {
      if (this.stopping) return
      const detail = this.stderr.trim()
      this.#fail(new Error("Codex app-server exited (code=" + code + ", signal=" + signal + ")" + (detail ? ": " + detail.slice(-1000) : "")))
      this.emit("exit", { code, signal, detail })
    })
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
      this.emit("diagnostic", String(chunk).trim())
    })
    this.lines = readline.createInterface({ input: this.process.stdout })
    this.lines.on("line", (line) => this.#receive(line))
    this.serverInfo = await this.request("initialize", {
      clientInfo: { name: "agent-task-hub", title: "Agent Task Hub", version: "0.2.3" },
      capabilities: { experimentalApi: true },
    })
    this.notify("initialized", {})
    this.ready = true
    return this
  }

  async stop() {
    this.stopping = true
    this.ready = false
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.monitorTimer = null
    if (!this.process) return
    this.#fail(new Error("Codex app-server stopped"))
    this.lines?.close()
    this.process.stdin?.end()
    const child = this.process
    this.process = null
    if (child.exitCode === null && !child.killed) child.kill()
  }

  #fail(error) {
    this.ready = false
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
  }

  #write(message) {
    if (!this.process?.stdin?.writable) throw new Error("Codex app-server is not running")
    this.process.stdin.write(JSON.stringify(message) + "\n")
  }

  notify(method, params = {}) {
    this.#write({ method, params })
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Codex app-server request timed out: " + method))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.#write({ method, id, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  respond(id, result) {
    this.#write({ id, result })
  }

  respondError(id, code = -32601, message = "Unsupported request") {
    this.#write({ id, error: { code, message } })
  }

  #receive(line) {
    let message
    try { message = JSON.parse(line) } catch {
      this.emit("diagnostic", "Invalid app-server JSON: " + String(line).slice(0, 500))
      return
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error("Codex " + pending.method + " failed: " + (message.error.message || JSON.stringify(message.error))))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message)
      return
    }
    if (message.method) this.#notification(message.method, message.params || {})
  }

  #rememberThread(thread) {
    if (thread?.id) this.threads.set(String(thread.id), thread)
    return thread
  }

  #notification(method, params) {
    if (params.thread) this.#rememberThread(params.thread)
    if (method === "thread/status/changed" && params.threadId) {
      const previous = this.threads.get(String(params.threadId)) || { id: String(params.threadId), cwd: "", turns: [] }
      this.#rememberThread({ ...previous, status: params.status })
    } else if (method === "turn/started" && params.threadId && params.turn?.id) {
      this.activeTurns.set(String(params.threadId), String(params.turn.id))
    } else if (method === "item/completed" && params.threadId && params.item?.type === "agentMessage") {
      this.latestMessages.set(String(params.threadId), String(params.item.text || ""))
    } else if (method === "turn/diff/updated" && params.threadId) {
      this.diffs.set(String(params.threadId), String(params.diff || ""))
    } else if (method === "turn/completed" && params.threadId) {
      const threadId = String(params.threadId)
      this.activeTurns.delete(threadId)
      if (params.turn?.id) this.observedTurns.add(String(params.turn.id))
      const event = terminalEventFromNotification(params, this.threads.get(threadId), this.latestMessages.get(threadId), this.diffs.get(threadId))
      this.latestMessages.delete(threadId)
      this.diffs.delete(threadId)
      this.emit("terminal", event)
    }
    this.emit("notification", { method, params })
  }

  async listSessions({ limit = 100 } = {}) {
    const sessions = []
    let cursor = null
    do {
      const response = await this.request("thread/list", {
        cursor,
        limit: Math.min(100, Math.max(1, limit - sessions.length)),
        archived: false,
        sortKey: "recency_at",
        sortDirection: "desc",
      })
      for (const thread of response?.data || []) {
        this.#rememberThread(thread)
        sessions.push(codexThreadToSession(thread))
      }
      cursor = response?.nextCursor || null
    } while (cursor && sessions.length < limit)
    return sessions
  }

  async #pollExternalCompletions(limit = 100) {
    if (this.monitorBusy || !this.ready) return
    this.monitorBusy = true
    try {
      const response = await this.request("thread/list", { limit, archived: false, sortKey: "recency_at", sortDirection: "desc" })
      for (const listed of response?.data || []) {
        this.#rememberThread(listed)
        const threadId = String(listed.id)
        const version = unixMilliseconds(listed.updatedAt || listed.recencyAt || listed.createdAt)
        const previous = this.threadVersions.get(threadId)
        this.threadVersions.set(threadId, version)
        if (previous === undefined && !this.monitorInitialized) continue
        if (previous !== undefined && version <= previous) continue
        const thread = await this.readThread(threadId)
        const threshold = previous === undefined ? this.monitorStartedAt : previous - 2000
        const turn = externalTerminalTurn(thread, { threshold, observedTurns: this.observedTurns })
        if (!turn) continue
        this.observedTurns.add(String(turn.id))
        this.emit("terminal", terminalEventFromNotification({ threadId, turn }, thread))
      }
    } finally {
      this.monitorBusy = false
    }
  }

  async startMonitor({ intervalMs = 5000, limit = 100 } = {}) {
    if (this.monitorTimer) return
    this.monitorStartedAt = Date.now()
    await this.#pollExternalCompletions(limit)
    this.monitorInitialized = true
    this.monitorTimer = setInterval(() => {
      void this.#pollExternalCompletions(limit).catch((error) => this.emit("diagnostic", "Codex monitor failed: " + error.message))
    }, Math.max(2000, intervalMs))
    this.monitorTimer.unref?.()
  }

  async readThread(threadId) {
    const response = await this.request("thread/read", { threadId: String(threadId), includeTurns: true })
    return this.#rememberThread(response?.thread)
  }

  async resumeThread(threadId) {
    const response = await this.request("thread/resume", { threadId: String(threadId) })
    return this.#rememberThread(response?.thread)
  }

  async sendPrompt(threadId, text) {
    await this.resumeThread(threadId)
    const response = await this.request("turn/start", {
      threadId: String(threadId),
      input: [{ type: "text", text: String(text) }],
    }, 30000)
    if (response?.turn?.id) this.activeTurns.set(String(threadId), String(response.turn.id))
    return response?.turn
  }

  async interrupt(threadId) {
    let turnId = this.activeTurns.get(String(threadId))
    if (!turnId) {
      const thread = await this.readThread(threadId)
      turnId = [...(thread?.turns || [])].reverse().find((turn) => turn?.status === "inProgress")?.id
    }
    if (!turnId) throw new Error("Codex task has no active turn")
    await this.request("turn/interrupt", { threadId: String(threadId), turnId: String(turnId) })
  }

  async status(threadId) {
    const thread = await this.readThread(threadId)
    return statusText(thread?.status)
  }
}
