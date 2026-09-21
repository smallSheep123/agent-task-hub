import { spawn } from "node:child_process"
import { createDecipheriv, createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import readline from "node:readline"

const ZCODE_INSTANCE_ID = "zcode-local"
const ACCOUNT_KEY = /^account-provider:coding-plan:(account:[^:]+):account:([^:]+):api-key$/

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return fallback }
}

function timestamp(value) {
  let number = Number(value || 0)
  if (number > 0 && number < 1e12) number *= 1000
  return Number.isFinite(number) ? number : 0
}

function statusText(value) {
  const status = String(value || "idle").toLowerCase()
  if (["running", "waiting", "paused", "active", "busy"].includes(status)) return "busy"
  if (status === "error" || status === "failed") return "error"
  return "idle"
}

function workspacePath(value) {
  return String(value?.workspacePath || value?.path || value?.cwd || "")
}

function workspaceRef(directory) {
  const path = resolve(String(directory || process.cwd()))
  return {
    workspacePath: path,
    workspaceKey: `local:${createHash("sha256").update(path.toLowerCase()).digest("hex").slice(0, 24)}`,
  }
}

function titleForSession(value) {
  return String(value?.title || "ZCode task").split(/\r?\n/, 1)[0].trim().slice(0, 180) || "ZCode task"
}

export function zcodeSessionToHubSession(session) {
  return {
    id: String(session?.sessionId || session?.id || ""),
    backend: "zcode",
    instanceId: ZCODE_INSTANCE_ID,
    title: titleForSession(session),
    directory: workspacePath(session?.workspace),
    status: statusText(session?.status),
    zcodeStatus: String(session?.status || "idle"),
    model: session?.model || null,
    updatedAt: timestamp(session?.updatedAt || session?.createdAt),
    createdAt: timestamp(session?.createdAt),
    activeTurnId: session?.activeTurnId || null,
    dashboardStartedAt: timestamp(session?.activeStartedAt),
  }
}

export function zcodeTerminalEvent(event, session = null) {
  const failed = event?.type === "turn.failed"
  const cancelled = event?.type === "turn.completed" && event?.payload?.resultType === "cancelled"
  return {
    version: 1,
    backend: "zcode",
    instanceId: ZCODE_INSTANCE_ID,
    id: `zcode:${String(event?.eventId || randomUUID())}`,
    type: failed ? "session.error" : cancelled ? "session.interrupted" : "session.idle",
    status: failed ? "failed" : cancelled ? "interrupted" : "completed",
    createdAt: new Date(timestamp(event?.timestamp) || Date.now()).toISOString(),
    sessionId: String(event?.sessionId || session?.sessionId || session?.id || ""),
    turnId: String(event?.turnId || ""),
    title: titleForSession(session),
    directory: workspacePath(session?.workspace),
    excerpt: String(event?.payload?.response || "").trim().slice(0, 1800),
    error: failed ? String(event?.payload?.error?.message || "ZCode turn failed").slice(0, 1000) : null,
    durationMs: Number(event?.payload?.duration || 0) || null,
  }
}

export function resolveZCodeBundle(value = "") {
  const requested = String(value || process.env.AGENT_TASK_HUB_ZCODE_BUNDLE || "").trim()
  const candidates = [
    requested,
    process.platform === "win32" ? join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "resources", "glm", "zcode.cjs") : "",
    process.platform === "win32" ? join(process.env.ProgramFiles || "", "ZCode", "resources", "glm", "zcode.cjs") : "",
    process.platform === "win32" ? "D:\\tool\\zcode\\resources\\glm\\zcode.cjs" : "",
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error("ZCode app-server bundle was not found; set zcodeBundle in config.json")
  return resolve(found)
}

function decryptCredential(value, secret) {
  if (!String(value || "").startsWith("enc:v1:")) return String(value || "")
  const [ivRaw, tagRaw, cipherRaw] = value.slice(7).split(".")
  const key = createHash("sha256").update(secret).digest()
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"))
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(cipherRaw, "base64url")), decipher.final()]).toString("utf8")
}

function credentialSecrets(env = process.env) {
  let currentUser = "unknown"
  try { currentUser = userInfo().username } catch {}
  const names = [currentUser, env.USERNAME, basename(homedir())].filter(Boolean)
  return [...new Set([
    env.ZCODE_CREDENTIAL_SECRET?.trim(),
    ...names.map((name) => `zcode-credential-fallback:${platform()}:${homedir()}:${name}`),
  ].filter(Boolean))]
}

function decryptFirst(value, env = process.env) {
  if (!String(value || "").startsWith("enc:v1:")) return String(value || "")
  for (const secret of credentialSecrets(env)) {
    try { return decryptCredential(value, secret) } catch {}
  }
  return null
}

export function loadZCodeAccount(dataRoot = join(homedir(), ".zcode", "v2"), env = process.env) {
  const credentials = readJson(join(dataRoot, "credentials.json"), {}) || {}
  const providerConfig = readJson(join(dataRoot, "config.json"), {}) || {}
  const accounts = new Map()
  for (const [key, encrypted] of Object.entries(credentials)) {
    const match = key.match(ACCOUNT_KEY)
    if (!match) continue
    const apiKey = decryptFirst(encrypted, env)
    if (apiKey?.trim()) accounts.set(match[1], { identity: decodeURIComponent(match[2]), apiKey: apiKey.trim() })
  }
  const legacy = providerConfig?.provider || {}
  const fallbacks = [
    ["account:bigmodel-individual-coding-plan", legacy["builtin:bigmodel-coding-plan"]?.options?.apiKey],
    ["account:bigmodel-start-plan", legacy["builtin:bigmodel-start-plan"]?.options?.apiKey],
    ["account:zai-individual-coding-plan", legacy["builtin:zai-coding-plan"]?.options?.apiKey],
    ["account:zai-start-plan", legacy["builtin:zai-start-plan"]?.options?.apiKey],
  ]
  for (const [providerId, apiKey] of fallbacks) {
    if (!accounts.has(providerId) && String(apiKey || "").trim()) accounts.set(providerId, { identity: "legacy", apiKey: String(apiKey).trim() })
  }
  return accounts
}

function versionParts(value) {
  return String(value || "").split(".").map((item) => Number.parseInt(item, 10) || 0)
}

function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}

function activeBuiltinFile(bundle, dataRoot) {
  const platformName = process.platform === "win32" ? "windows" : process.platform
  const archName = process.arch === "x64" ? "x86_64" : process.arch
  const runtimeRoot = join(dataRoot, "runtime", "provider", `${platformName}-${archName}`)
  const candidates = []
  try {
    for (const version of readdirSync(runtimeRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const versionRoot = join(runtimeRoot, version.name)
      for (const endpoint of readdirSync(versionRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
        const path = join(versionRoot, endpoint.name, "zcode-builtin.json")
        if (existsSync(path)) candidates.push({ path, version: version.name, mtime: statSync(path).mtimeMs })
      }
    }
  } catch {}
  candidates.sort((left, right) => compareVersions(right.version, left.version) || right.mtime - left.mtime)
  if (candidates[0]) return candidates[0].path
  return resolve(join(dirname(bundle), "..", "config", "provider", "zcode-builtin.json"))
}

export function zcodeAccountOverlay(bundle, dataRoot = join(homedir(), ".zcode", "v2"), env = process.env) {
  const accounts = loadZCodeAccount(dataRoot, env)
  if (!accounts.size) throw new Error("No usable ZCode account credential was found")
  const activePath = activeBuiltinFile(bundle, dataRoot)
  const release = readJson(activePath)
  if (!release?.revision) throw new Error("ZCode built-in provider config is unavailable")
  const basedOnZCodeBuiltinRevision = `zcode-builtin:${release.revision}:${createHash("sha256").update(resolve(activePath)).digest("hex")}`
  const providers = {}
  const states = {}
  const accountRules = (release?.config?.providerConfigRules?.providerRules || [])
    .filter((rule) => String(rule?.providerId || "").startsWith("account:") && rule?.config?.access?.type === "zhipu-account")
  const preferredProviders = [
    "account:bigmodel-individual-coding-plan",
    "account:zai-individual-coding-plan",
    "account:bigmodel-team-coding-plan",
    "account:zai-team-coding-plan",
    "account:bigmodel-start-plan",
    "account:zai-start-plan",
  ]
  const primaryProviderId = preferredProviders.find((providerId) => accounts.has(providerId)) || [...accounts.keys()][0]
  const primaryRegion = primaryProviderId.includes(":zai-") ? "zai" : "bigmodel"
  const offpeakProviderId = `account:${primaryRegion}-offpeak-idle-plan`

  // ZCode Desktop sends a complete snapshot for every built-in account provider.
  // Omitting unavailable entries makes updateAccountConfig acknowledge the update,
  // but leaves the provider/model registry without the entitled provider.
  for (const rule of accountRules) {
    const providerId = rule.providerId
    const entitled = providerId === primaryProviderId || providerId === offpeakProviderId
    providers[providerId] = { access: { type: "zhipu-account", entitled } }
    const sameRegion = providerId.includes(`:${primaryRegion}-`)
    const isTeam = providerId.includes("-team-")
    const isStart = providerId.includes("-start-")
    const isOffpeak = providerId.includes("-offpeak-")
    states[providerId] = entitled
      ? { availability: "available", entitled: true, ...(isOffpeak ? {} : { current: true }) }
      : {
          availability: sameRegion && isTeam ? "unknown" : "unavailable",
          entitled: false,
          ...(!isOffpeak ? { current: sameRegion && isStart } : {}),
          ...(!isOffpeak && !(sameRegion && isTeam) ? { unavailableReason: sameRegion ? "not-entitled" : "not-connected" } : {}),
        }
  }
  const providerEntries = accountRules.map((rule) => ({ providerId: rule.providerId, config: providers[rule.providerId] }))
  const revision = `account:${JSON.stringify([basedOnZCodeBuiltinRevision, providerEntries, states])}`
  return {
    accounts,
    activePath,
    primaryProviderId,
    request: {
      revision,
      basedOnZCodeBuiltinRevision,
      providers,
      states,
    },
  }
}

export class ZCodeAppServer extends EventEmitter {
  constructor({
    bundle = process.env.AGENT_TASK_HUB_ZCODE_BUNDLE || "",
    dataRoot = process.env.ZCODE_DATA_ROOT || join(homedir(), ".zcode", "v2"),
    requestTimeoutMs = 30000,
    spawnFactory = spawn,
  } = {}) {
    super()
    this.bundle = bundle
    this.dataRoot = dataRoot
    this.requestTimeoutMs = requestTimeoutMs
    this.spawnFactory = spawnFactory
    this.process = null
    this.lines = null
    this.nextId = 1
    this.pending = new Map()
    this.sessions = new Map()
    this.eventSeq = new Map()
    this.subscriptions = new Set()
    this.seenEventIds = new Set()
    this.activeStartedAt = new Map()
    this.monitorTimer = null
    this.monitorBusy = false
    this.ready = false
    this.stopping = false
    this.stderr = ""
    this.connectionId = randomUUID()
    this.accounts = new Map()
    this.defaultProviderId = ""
  }

  get isRunning() { return Boolean(this.process && this.process.exitCode === null && !this.process.killed) }

  async start() {
    if (this.ready && this.isRunning) return this
    const bundle = resolveZCodeBundle(this.bundle)
    this.bundle = bundle
    this.stopping = false
    const overlay = zcodeAccountOverlay(bundle, this.dataRoot)
    const appVersion = basename(dirname(dirname(overlay.activePath)))
    const child = this.spawnFactory(process.execPath, [bundle, "app-server", "--surface", "desktop"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: overlay.activePath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(this.dataRoot, "provider_config.json"),
        ZCODE_APP_VERSION: appVersion,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.process = child
    child.stderr?.setEncoding?.("utf8")
    child.stderr?.on?.("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-8000) })
    child.once("error", (error) => this.#fail(error))
    child.once("exit", (code, signal) => {
      const detail = this.stderr.trim().split(/\r?\n/).slice(-3).join("\n")
      this.#fail(new Error(`ZCode app-server stopped (code=${code}, signal=${signal || "none"})${detail ? `: ${detail}` : ""}`))
      if (!this.stopping) this.emit("exit", { code, signal, detail })
    })
    this.lines = readline.createInterface({ input: child.stdout })
    this.lines.on("line", (line) => this.#receive(line))
    this.accounts = overlay.accounts
    this.defaultProviderId = overlay.primaryProviderId
    this.accountSyncResult = await this.request("provider/updateAccountConfig", overlay.request, 45000)
    await this.listSessions({ limit: 1 })
    this.ready = true
    return this
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.isRunning) return Promise.reject(new Error("ZCode app-server is not running"))
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ZCode request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve: resolvePromise, reject, timer })
      this.#write({ id, method, params })
    })
  }

  respond(id, result) { this.#write({ id, result }) }
  respondError(id, code, message) { this.#write({ id, error: { code, message } }) }

  #write(value) {
    if (!this.process?.stdin?.writable) throw new Error("ZCode app-server input is closed")
    this.process.stdin.write(`${JSON.stringify(value)}\n`)
  }

  #receive(line) {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.method && message.id !== undefined) {
      if (message.method === "session/requestRuntimePreferences") {
        this.respond(message.id, { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: "preflight-v1" })
        return
      }
      if (message.method === "interaction/requestProviderRuntimeHeaders") {
        const providerId = String(message.params?.providerId || "")
        const account = this.accounts.get(providerId)
        this.emit("runtimeAuth", { providerId, credentialFound: Boolean(account?.apiKey), reason: message.params?.reason || "model-request" })
        if (account?.apiKey) this.respond(message.id, { headersApplied: true, requestAuth: { apiKey: account.apiKey } })
        else this.respond(message.id, { headersApplied: false, errorMessage: "ZCode account credential is unavailable" })
        return
      }
      this.emit("serverRequest", message)
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`ZCode ${pending.method} failed: ${message.error.message || "unknown error"}`))
      else pending.resolve(message.result)
      return
    }
    if (message.method) {
      if (message.method === "session/event") this.#acceptEvent(message.params)
      this.emit("notification", message)
    }
  }

  #fail(error) {
    this.ready = false
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  async listSessions({ limit = 200 } = {}) {
    const result = await this.request("session/list", { limit, includeArchived: false }, 60000)
    const list = Array.isArray(result?.sessions) ? result.sessions : []
    for (const item of list) this.sessions.set(String(item.sessionId || item.id), item)
    return list.filter((item) => item?.sessionKind === "interactive").map((item) => {
      const session = zcodeSessionToHubSession(item)
      session.activeStartedAt = this.activeStartedAt.get(session.id) || 0
      session.dashboardStartedAt = session.activeStartedAt
      return session
    })
  }

  async readSession(sessionId, messageLimit = 12) {
    const id = String(sessionId)
    let result
    try {
      result = await this.request("session/read", { sessionId: id, messageLimit })
    } catch (error) {
      if (!/not active/i.test(error.message)) throw error
      await this.resume(this.sessions.get(id) || id)
      result = await this.request("session/read", { sessionId: id, messageLimit })
    }
    const info = result?.session || result?.snapshot?.session || this.sessions.get(String(sessionId)) || { sessionId }
    this.sessions.set(String(sessionId), info)
    return result
  }

  async status(sessionId) {
    const result = await this.readSession(sessionId, 1)
    return statusText(result?.session?.status || result?.snapshot?.session?.status || result?.status)
  }

  async resume(session) {
    const cached = typeof session === "object" ? session : this.sessions.get(String(session))
    const sessionId = String(cached?.sessionId || cached?.id || session)
    const workspace = cached?.workspace || (cached?.directory ? workspaceRef(cached.directory) : undefined)
    const result = await this.request("session/resume", { sessionId, ...(workspace ? { workspace } : {}) }, 60000)
    return result
  }

  async sendPrompt(sessionId, content) {
    const id = String(sessionId)
    await this.resume(this.sessions.get(id) || id).catch((error) => {
      if (!/already|resident|active/i.test(error.message)) throw error
    })
    await this.#subscribe(id)
    const result = await this.request("session/send", { sessionId: id, content: String(content), inputId: randomUUID(), queryId: randomUUID() }, 60000)
    return { id: null, accepted: result?.accepted === true }
  }

  async startSession({ cwd, model = null, thoughtLevel = "high", mode = "build" } = {}) {
    const selection = model || { providerId: this.defaultProviderId || this.accounts.keys().next().value, modelId: "GLM-5.3", options: { reasoningLevel: thoughtLevel } }
    const result = await this.request("session/create", {
      workspace: workspaceRef(cwd), mode, model: selection, thoughtLevel,
      persistence: "immediate", titleGenerationEnabled: true,
    }, 60000)
    const info = result?.session || result?.snapshot?.session || result
    if (!info?.sessionId && !info?.id) throw new Error("ZCode session/create returned no session id")
    const sessionId = String(info.sessionId || info.id)
    this.sessions.set(sessionId, info)
    await this.#subscribe(sessionId)
    return zcodeSessionToHubSession(info)
  }

  async interrupt(sessionId) { return this.request("session/stop", { sessionId: String(sessionId) }) }

  async #subscribe(sessionId) {
    const id = String(sessionId)
    if (this.subscriptions.has(id)) return
    const result = await this.request("session/subscribe", {
      sessionId: id,
      deliveryKind: "web-remote-replayable",
      afterSeq: 0,
      includeSnapshot: false,
    }, 60000)
    const events = Array.isArray(result?.events) ? result.events : []
    const maximum = events.reduce((max, event) => Math.max(max, Number(event?.seq || event?.sequenceNumber || 0)), Number(result?.eventSeq || 0))
    this.eventSeq.set(id, maximum)
    for (const event of events) if (event?.eventId) this.seenEventIds.add(String(event.eventId))
    this.subscriptions.add(id)
  }

  #acceptEvent(event) {
    if (!event || typeof event !== "object") return
    const sessionId = String(event.sessionId || "")
    if (!sessionId) return
    const eventId = String(event.eventId || "")
    if (eventId && this.seenEventIds.has(eventId)) return
    if (eventId) this.seenEventIds.add(eventId)
    const sequence = Number(event.seq || event.sequenceNumber || 0)
    if (sequence > 0) this.eventSeq.set(sessionId, Math.max(this.eventSeq.get(sessionId) || 0, sequence))
    if (event.type === "turn.started") this.activeStartedAt.set(sessionId, timestamp(event.timestamp) || Date.now())
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      this.activeStartedAt.delete(sessionId)
      this.emit("terminal", zcodeTerminalEvent(event, this.sessions.get(sessionId)))
    }
  }

  async #pollEvents() {
    if (this.monitorBusy) return
    this.monitorBusy = true
    try {
      const listedSessions = await this.listSessions({ limit: 200 })
      const sessionsById = new Map(listedSessions.map((session) => [session.id, session]))
      for (const [sessionId, info] of this.sessions) {
        if (!sessionsById.has(sessionId)) sessionsById.set(sessionId, zcodeSessionToHubSession(info))
      }
      const sessions = [...sessionsById.values()]
      for (const hubSession of sessions) {
        const session = this.sessions.get(hubSession.id)
        const previous = this.eventSeq.get(hubSession.id)
        let result
        try { result = await this.request("session/events", { sessionId: hubSession.id, ...(previous === undefined ? {} : { afterSeq: previous }), limit: 200 }) } catch { continue }
        const events = Array.isArray(result?.events) ? result.events : []
        const maximum = events.reduce((max, event) => Math.max(max, Number(event?.seq || event?.sequenceNumber || 0)), previous || 0)
        this.eventSeq.set(hubSession.id, maximum)
        if (previous === undefined) continue
        for (const event of events.sort((left, right) => Number(left?.seq || 0) - Number(right?.seq || 0))) {
          if (Number(event?.seq || event?.sequenceNumber || 0) <= previous) continue
          this.#acceptEvent(event)
        }
      }
    } finally { this.monitorBusy = false }
  }

  async startMonitor({ intervalMs = 5000 } = {}) {
    await this.#pollEvents()
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.monitorTimer = setInterval(() => { void this.#pollEvents().catch((error) => this.emit("diagnostic", error.message)) }, Math.max(2000, intervalMs))
    this.monitorTimer.unref?.()
  }

  async stop() {
    this.stopping = true
    this.ready = false
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.monitorTimer = null
    const child = this.process
    this.process = null
    this.lines?.close?.()
    this.lines = null
    if (child && child.exitCode === null && !child.killed) {
      child.stdin?.end?.()
      await new Promise((resolvePromise) => {
        const timer = setTimeout(() => { child.kill(); resolvePromise() }, 1000)
        child.once("exit", () => { clearTimeout(timer); resolvePromise() })
      })
    }
  }
}
