import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readdirSync, statSync } from "node:fs"
import { delimiter, dirname, extname, join } from "node:path"
import readline from "node:readline"

const CODEX_INSTANCE_ID = "codex-local"
const CODEX_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"]
const CODEX_TRANSPORTS = new Set(["private", "shared", "auto"])

export function normalizeCodexTransport(value = "private") {
  const transport = String(value || "private").trim().toLowerCase()
  return CODEX_TRANSPORTS.has(transport) ? transport : "private"
}

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

export function resolveCodexLaunch(command = "codex", transport = "private") {
  const selectedTransport = normalizeCodexTransport(transport) === "shared" ? "shared" : "private"
  const appServerArgs = selectedTransport === "shared" ? ["app-server", "proxy"] : ["app-server", "--stdio"]
  const requested = String(command || "codex")
  const desktop = requested.toLowerCase() === "codex" ? desktopCodexExecutable() : null
  if (desktop) return { command: desktop, args: appServerArgs, transport: selectedTransport }
  const resolved = executableCandidates(requested).find((candidate) => existsSync(candidate)) || requested
  if (process.platform !== "win32") return { command: resolved, args: appServerArgs, transport: selectedTransport }
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
    if (native) return { command: native, args: appServerArgs, transport: selectedTransport }
  }
  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...appServerArgs],
      transport: selectedTransport,
    }
  }
  if (extension === ".cmd" || extension === ".bat") {
    const script = resolved.slice(0, -extension.length) + ".ps1"
    if (existsSync(script)) {
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...appServerArgs],
        transport: selectedTransport,
      }
    }
    const safe = resolved.replaceAll("%", "%%").replaceAll('"', '""')
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", '"' + safe + '" ' + appServerArgs.join(" ")], transport: selectedTransport }
  }
  return { command: resolved, args: appServerArgs, transport: selectedTransport }
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
  constructor({
    command = process.env.AGENT_TASK_HUB_CODEX_COMMAND || "codex",
    transport = process.env.AGENT_TASK_HUB_CODEX_TRANSPORT || "private",
    wsUrl = process.env.AGENT_TASK_HUB_CODEX_WS_URL || "",
    requestTimeoutMs = 20000,
    sharedConnectTimeoutMs = 5000,
    spawnFactory = spawn,
    webSocketFactory = null,
  } = {}) {
    super()
    this.command = command
    this.requestedTransport = normalizeCodexTransport(transport)
    this.transport = null
    this.wsUrl = String(wsUrl || "").trim()
    this.connectionId = randomUUID()
    this.requestTimeoutMs = requestTimeoutMs
    this.sharedConnectTimeoutMs = sharedConnectTimeoutMs
    this.spawnFactory = spawnFactory
    this.webSocketFactory = webSocketFactory
    this.process = null
    this.socket = null
    this.lines = null
    this.nextId = 1
    this.pending = new Map()
    this.threads = new Map()
    this.loadedThreads = new Set()
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
    this.expectedExits = new WeakSet()
    this.expectedSocketCloses = new WeakSet()
  }

  get isRunning() {
    if (this.socket) return this.socket.readyState === 1
    return Boolean(this.process && this.process.exitCode === null && !this.process.killed)
  }

  async start() {
    if (this.ready && this.isRunning) return this
    this.stopping = false
    const attempts = this.requestedTransport === "auto" ? ["shared", "private"] : [this.requestedTransport]
    let lastError = null
    for (const transport of attempts) {
      try {
        if (transport === "shared" && this.wsUrl) await this.#startWebSocket()
        else await this.#startTransport(transport)
        return this
      } catch (error) {
        lastError = error
        await this.#discardConnection(error)
        if (this.requestedTransport === "auto" && transport === "shared") {
          this.emit("diagnostic", "Shared Codex app-server unavailable; falling back to private stdio: " + error.message)
        }
      }
    }
    throw lastError || new Error("Codex app-server failed to start")
  }

  async #startWebSocket() {
    if (!/^ws:\/\/127\.0\.0\.1:\d+(?:\/.*)?$/i.test(this.wsUrl) && !/^ws:\/\/localhost:\d+(?:\/.*)?$/i.test(this.wsUrl)) {
      throw new Error("Shared Codex WebSocket must use a loopback ws:// URL")
    }
    const factory = this.webSocketFactory || ((url) => {
      if (typeof WebSocket !== "function") throw new Error("This Node.js runtime does not provide WebSocket support")
      return new WebSocket(url)
    })
    const socket = factory(this.wsUrl)
    this.socket = socket
    this.transport = "shared-websocket"
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Shared Codex WebSocket connection timed out")), this.sharedConnectTimeoutMs)
      const opened = () => { clearTimeout(timer); resolve() }
      const failed = () => { clearTimeout(timer); reject(new Error("Shared Codex WebSocket connection failed")) }
      socket.addEventListener("open", opened, { once: true })
      socket.addEventListener("error", failed, { once: true })
    })
    socket.addEventListener("message", (event) => this.#receive(String(event.data)))
    socket.addEventListener("error", () => {
      if (!this.expectedSocketCloses.has(socket) && this.socket === socket) this.emit("diagnostic", "Shared Codex WebSocket transport error")
    })
    socket.addEventListener("close", (event) => {
      if (this.stopping || this.expectedSocketCloses.has(socket) || this.socket !== socket) return
      const detail = String(event.reason || "")
      this.#fail(new Error(`Shared Codex WebSocket closed (code=${event.code})${detail ? ": " + detail : ""}`))
      this.emit("exit", { code: event.code, signal: null, detail })
    })
    this.serverInfo = await this.request("initialize", {
      clientInfo: { name: "agent-task-hub", title: "Agent Task Hub", version: "0.4.0" },
      capabilities: { experimentalApi: true },
    }, Math.min(this.requestTimeoutMs, this.sharedConnectTimeoutMs))
    this.notify("initialized", {})
    this.ready = true
  }

  async #startTransport(transport) {
    const launch = resolveCodexLaunch(this.command, transport)
    const child = this.spawnFactory(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env },
    })
    this.process = child
    this.transport = launch.transport
    this.stderr = ""
    child.on("error", (error) => this.#fail(error))
    child.on("exit", (code, signal) => {
      if (this.stopping || this.expectedExits.has(child) || this.process !== child) return
      const detail = this.stderr.trim()
      this.#fail(new Error("Codex app-server exited (code=" + code + ", signal=" + signal + ")" + (detail ? ": " + detail.slice(-1000) : "")))
      this.emit("exit", { code, signal, detail })
    })
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000)
      this.emit("diagnostic", String(chunk).trim())
    })
    this.lines = readline.createInterface({ input: child.stdout })
    this.lines.on("line", (line) => this.#receive(line))
    this.serverInfo = await this.request("initialize", {
      clientInfo: { name: "agent-task-hub", title: "Agent Task Hub", version: "0.4.0" },
      capabilities: { experimentalApi: true },
    }, transport === "shared" ? Math.min(this.requestTimeoutMs, this.sharedConnectTimeoutMs) : this.requestTimeoutMs)
    this.notify("initialized", {})
    this.ready = true
  }

  async #discardProcess(error = new Error("Codex app-server connection closed")) {
    const child = this.process
    if (!child) return
    this.expectedExits.add(child)
    this.#fail(error)
    this.lines?.close()
    this.lines = null
    child.stdin?.end()
    this.process = null
    this.transport = null
    if (child.exitCode === null && !child.killed) child.kill()
  }

  async #discardSocket(error = new Error("Codex app-server connection closed")) {
    const socket = this.socket
    if (!socket) return
    this.expectedSocketCloses.add(socket)
    this.#fail(error)
    this.socket = null
    this.transport = null
    if (socket.readyState === 0 || socket.readyState === 1) socket.close(1000, "Agent Task Hub disconnecting")
  }

  async #discardConnection(error = new Error("Codex app-server connection closed")) {
    await this.#discardSocket(error)
    await this.#discardProcess(error)
  }

  async stop() {
    this.stopping = true
    this.ready = false
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.monitorTimer = null
    if (!this.process && !this.socket) return
    await this.#discardConnection(new Error("Codex app-server stopped"))
  }

  #fail(error) {
    this.ready = false
    this.loadedThreads.clear()
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.pending.clear()
  }

  #write(message) {
    const serialized = JSON.stringify(message)
    if (this.socket?.readyState === 1) {
      this.socket.send(serialized)
      return
    }
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(serialized + "\n")
      return
    }
    throw new Error("Codex app-server is not running")
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
    } else if (method === "thread/name/updated" && params.threadId) {
      const previous = this.threads.get(String(params.threadId)) || { id: String(params.threadId), cwd: "", turns: [] }
      this.#rememberThread({ ...previous, name: String(params.name || "") })
    } else if ((method === "thread/closed" || method === "thread/archived" || method === "thread/deleted") && params.threadId) {
      this.loadedThreads.delete(String(params.threadId))
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
        sourceKinds: CODEX_SOURCE_KINDS,
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
      const response = await this.request("thread/list", { limit, archived: false, sortKey: "recency_at", sortDirection: "desc", sourceKinds: CODEX_SOURCE_KINDS })
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
    let lastError = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await this.request("thread/read", { threadId: String(threadId), includeTurns: true })
        return this.#rememberThread(response?.thread)
      } catch (error) {
        lastError = error
        if (!/(no rollout found|thread-store internal error|failed to read session)/i.test(String(error?.message || error))) throw error
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const cached = this.threads.get(String(threadId))
    if (cached && this.loadedThreads.has(String(threadId))) return cached
    throw lastError
  }

  async startThread({ cwd, model = null } = {}) {
    const params = { serviceName: "agent_task_hub" }
    if (cwd) params.cwd = String(cwd)
    if (model) params.model = String(model)
    const response = await this.request("thread/start", params, 30000)
    const thread = this.#rememberThread(response?.thread)
    if (thread?.id) this.loadedThreads.add(String(thread.id))
    return thread
  }

  async setThreadName(threadId, name) {
    await this.request("thread/name/set", { threadId: String(threadId), name: String(name) })
    const previous = this.threads.get(String(threadId)) || { id: String(threadId), cwd: "", turns: [] }
    this.#rememberThread({ ...previous, name: String(name) })
  }

  async resumeThread(threadId) {
    const response = await this.request("thread/resume", { threadId: String(threadId) })
    const thread = this.#rememberThread(response?.thread)
    if (thread?.id) this.loadedThreads.add(String(thread.id))
    return thread
  }

  async sendPrompt(threadId, text) {
    if (!this.loadedThreads.has(String(threadId))) await this.resumeThread(threadId)
    const response = await this.request("turn/start", {
      threadId: String(threadId),
      input: [{ type: "text", text: String(text) }],
    }, 30000)
    if (response?.turn?.id) this.activeTurns.set(String(threadId), String(response.turn.id))
    return response?.turn
  }

  async steer(threadId, text) {
    let turnId = this.activeTurns.get(String(threadId))
    if (!turnId) {
      const thread = await this.readThread(threadId)
      turnId = [...(thread?.turns || [])].reverse().find((turn) => turn?.status === "inProgress")?.id
    }
    if (!turnId) throw new Error("Codex task has no active turn")
    const response = await this.request("turn/steer", {
      threadId: String(threadId),
      input: [{ type: "text", text: String(text) }],
      expectedTurnId: String(turnId),
    })
    return response?.turnId || turnId
  }

  async interrupt(threadId) {
    let lastError = null
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let turnId = this.activeTurns.get(String(threadId))
      if (!turnId) {
        const thread = await this.readThread(threadId)
        turnId = [...(thread?.turns || [])].reverse().find((turn) => turn?.status === "inProgress")?.id
      }
      if (turnId) {
        try {
          await this.request("turn/interrupt", { threadId: String(threadId), turnId: String(turnId) })
          return
        } catch (error) {
          lastError = error
          if (!/no active turn/i.test(String(error?.message || error))) throw error
        }
      }
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw lastError || new Error("Codex task has no active turn")
  }

  async archiveThread(threadId) {
    await this.request("thread/archive", { threadId: String(threadId) })
    this.threads.delete(String(threadId))
    this.activeTurns.delete(String(threadId))
    this.loadedThreads.delete(String(threadId))
  }

  async status(threadId) {
    if (this.activeTurns.has(String(threadId))) return "busy"
    const cached = this.threads.get(String(threadId))
    if (statusText(cached?.status) === "busy") return "busy"
    const thread = await this.readThread(threadId)
    return statusText(thread?.status)
  }
}
