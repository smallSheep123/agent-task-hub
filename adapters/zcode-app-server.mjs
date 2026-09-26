import { spawn } from "node:child_process"
import { createDecipheriv, createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import readline from "node:readline"
import { DatabaseSync } from "node:sqlite"

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

function taskStatus(value) {
  const status = String(value || "completed").toLowerCase()
  if (["running", "waiting", "paused", "active", "busy"].includes(status)) return "running"
  if (["error", "failed"].includes(status)) return "error"
  return "completed"
}

function modelText(value) {
  if (typeof value === "string") return value
  const providerId = String(value?.providerId || "")
  const modelId = String(value?.modelId || "")
  return [providerId, modelId].filter(Boolean).join("/")
}

export function zcodeTaskIndexRecord(session, overrides = {}) {
  const taskId = String(session?.sessionId || session?.id || "")
  const workspace = workspacePath(session?.workspace) || String(session?.directory || "")
  const title = String(overrides.title || titleForSession(session)).slice(0, 500)
  const model = modelText(session?.model || overrides.model)
  const createdAt = timestamp(session?.createdAt) || Date.now()
  const updatedAt = timestamp(overrides.updatedAt || session?.updatedAt) || Date.now()
  const status = taskStatus(overrides.status || session?.status)
  const mode = String(session?.mode || overrides.mode || "build")
  const provider = String(session?.provider || overrides.provider || "glm")
  const thoughtLevel = String(session?.thoughtLevel || session?.model?.options?.reasoningLevel || overrides.thoughtLevel || "high")
  const meta = {
    taskId,
    ...(session?.traceId ? { traceId: String(session.traceId) } : {}),
    title,
    titleOverridden: false,
    workspacePath: workspace,
    createdAt,
    updatedAt,
    mode,
    model,
    thoughtLevel,
    provider,
    status,
    target: session?.target ?? null,
  }
  return {
    workspaceKey: workspace,
    workspacePath: workspace,
    taskId,
    title,
    status,
    provider,
    mode,
    model,
    forkedFromTaskId: session?.parentSessionId ? String(session.parentSessionId) : null,
    createdAt,
    updatedAt,
    metaJson: JSON.stringify(meta),
    searchableText: `${title}\n${workspace}`.trim(),
  }
}

export function upsertZCodeTaskIndex(dataRoot, session, overrides = {}) {
  const path = join(dataRoot, "tasks-index.sqlite")
  if (!existsSync(path)) return false
  const record = zcodeTaskIndexRecord(session, overrides)
  if (!record.taskId || !record.workspacePath) return false
  const db = new DatabaseSync(path)
  try {
    db.exec("PRAGMA busy_timeout=3000")
    db.prepare(`
      INSERT INTO tasks (
        workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
        provider, mode, model, migration_source, forked_from_task_id, created_at, updated_at,
        unread_at, last_unread_at, pinned, archived, deleted, title_overridden, meta_json,
        searchable_text, cron_automation_id, off_peak_task_id
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, 0, 0, 0, 0, ?, ?, NULL, NULL)
      ON CONFLICT(workspace_key, task_id) DO UPDATE SET
        workspace_path = excluded.workspace_path,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE tasks.title END,
        task_status = excluded.task_status,
        provider = excluded.provider,
        mode = excluded.mode,
        model = excluded.model,
        forked_from_task_id = COALESCE(excluded.forked_from_task_id, tasks.forked_from_task_id),
        updated_at = MAX(tasks.updated_at, excluded.updated_at),
        meta_json = excluded.meta_json,
        searchable_text = excluded.searchable_text
    `).run(
      record.workspaceKey, record.workspacePath, record.taskId, record.title, record.status,
      record.provider, record.mode, record.model, record.forkedFromTaskId, record.createdAt,
      record.updatedAt, record.metaJson, record.searchableText,
    )
    return true
  } finally { db.close() }
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

export function zcodeSessionNeedsEventPoll(session, { baseline = false, previousVersion, subscribed = false, resident = false, lastPolledAt = 0, now = Date.now(), recoveryIntervalMs = 30000 } = {}) {
  if (baseline || previousVersion === undefined) return true
  if (statusText(session?.status) === "busy") return true
  if (timestamp(session?.updatedAt || session?.updated || session?.createdAt) > Number(previousVersion || 0)) return true
  return (subscribed || resident) && now - Number(lastPolledAt || 0) >= recoveryIntervalMs
}

export function zcodeIndexCompletion(previous, current, monitorStartedAt) {
  if (!previous || current.updatedAt <= previous.updatedAt || current.updatedAt < monitorStartedAt - 5000) return false
  return ["completed", "error", "failed", "cancelled"].includes(current.status)
    && (previous.status !== current.status || previous.updatedAt < current.updatedAt)
}

export function zcodeLocalReply(dataRoot, sessionId, finishedAt, { maxAgeMs = 15 * 60_000 } = {}) {
  const path = join(dirname(dataRoot), "cli", "db", "db.sqlite")
  const end = timestamp(finishedAt)
  if (!sessionId || !end || !existsSync(path)) return ""
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const messages = db.prepare("SELECT id, data FROM message WHERE session_id = ? AND time_created BETWEEN ? AND ? ORDER BY time_created DESC LIMIT 100")
      .all(String(sessionId), end - maxAgeMs, end)
    for (const message of messages) {
      let info
      try { info = JSON.parse(message.data) } catch { continue }
      if (info?.role === "user") return ""
      if (info?.role !== "assistant" || (info.finish && info.finish !== "stop")) continue
      const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY sequence").all(message.id)
      const reply = parts.map((part) => {
        try { const value = JSON.parse(part.data); return value?.type === "text" ? String(value.text || "") : "" }
        catch { return "" }
      }).filter(Boolean).join("\n").trim()
      if (reply) return reply.slice(0, 1800)
    }
  } catch { return "" }
  finally { db?.close() }
  return ""
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
    this.residentSessions = new Set()
    this.seenEventIds = new Set()
    this.activeStartedAt = new Map()
    this.sessionVersions = new Map()
    this.sessionPolledAt = new Map()
    this.indexSnapshot = new Map()
    this.monitorStartedAt = 0
    this.monitorTimer = null
    this.monitorBusy = false
    this.monitorInitialized = false
    this.backgroundPausedUntil = 0
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
    return list.filter((item) => ["interactive", "fork"].includes(item?.sessionKind)).map((item) => {
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
    this.#syncTaskIndex(info)
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
    this.residentSessions.add(sessionId)
    return result
  }

  async sendPrompt(sessionId, content) {
    const id = String(sessionId)
    if (!this.residentSessions.has(id)) {
      await this.resume(this.sessions.get(id) || id).catch((error) => {
        if (!/already|resident|active/i.test(error.message)) throw error
        this.residentSessions.add(id)
      })
    }
    await this.#subscribe(id)
    this.#syncTaskIndex(this.sessions.get(id) || { sessionId: id }, { status: "running", updatedAt: Date.now() })
    const result = await this.request("session/send", { sessionId: id, content: String(content), inputId: randomUUID(), queryId: randomUUID() }, 60000)
    return { id: null, accepted: result?.accepted === true }
  }

  async startSession({ cwd, model = null, thoughtLevel = "high", mode = "build", title = null } = {}) {
    const selection = model || { providerId: this.defaultProviderId || this.accounts.keys().next().value, modelId: "GLM-5.3", options: { reasoningLevel: thoughtLevel } }
    const result = await this.request("session/create", {
      workspace: workspaceRef(cwd), mode, model: selection, thoughtLevel,
      persistence: "immediate", titleGenerationEnabled: true,
    }, 60000)
    const info = result?.session || result?.snapshot?.session || result
    if (!info?.sessionId && !info?.id) throw new Error("ZCode session/create returned no session id")
    const sessionId = String(info.sessionId || info.id)
    if (title) info.title = String(title)
    this.sessions.set(sessionId, info)
    this.residentSessions.add(sessionId)
    this.#syncTaskIndex(info, { title, status: "running", thoughtLevel })
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

  #syncTaskIndex(session, overrides = {}) {
    try { return upsertZCodeTaskIndex(this.dataRoot, session, overrides) }
    catch (error) {
      this.emit("diagnostic", `ZCode Desktop task index sync failed: ${error.message}`)
      return false
    }
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
    if (event.type === "turn.started") {
      this.activeStartedAt.set(sessionId, timestamp(event.timestamp) || Date.now())
      this.#syncTaskIndex(this.sessions.get(sessionId) || { sessionId }, { status: "running", updatedAt: event.timestamp })
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      this.activeStartedAt.delete(sessionId)
      this.#syncTaskIndex(this.sessions.get(sessionId) || { sessionId }, { status: event.type === "turn.failed" ? "error" : "completed", updatedAt: event.timestamp })
      this.emit("terminal", zcodeTerminalEvent(event, this.sessions.get(sessionId)))
    }
  }

  deferBackgroundPoll(durationMs = 5000) {
    this.backgroundPausedUntil = Math.max(this.backgroundPausedUntil, Date.now() + Math.max(0, Number(durationMs) || 0))
  }

  async #pollSessionEvents(hubSession) {
    const previous = this.eventSeq.get(hubSession.id)
    let result
    try { result = await this.request("session/events", { sessionId: hubSession.id, ...(previous === undefined ? {} : { afterSeq: previous }), limit: 200 }) }
    catch (error) {
      if (!/session is not active/i.test(error.message)) throw error
      this.sessionVersions.set(hubSession.id, timestamp(hubSession.updatedAt || hubSession.createdAt))
      this.sessionPolledAt.set(hubSession.id, Date.now())
      return
    }
    const events = Array.isArray(result?.events) ? result.events : []
    const maximum = events.reduce((max, event) => Math.max(max, Number(event?.seq || event?.sequenceNumber || 0)), previous || 0)
    this.eventSeq.set(hubSession.id, maximum)
    if (previous !== undefined) {
      for (const event of events.sort((left, right) => Number(left?.seq || 0) - Number(right?.seq || 0))) {
        if (Number(event?.seq || event?.sequenceNumber || 0) <= previous) continue
        this.#acceptEvent(event)
      }
    }
    this.sessionVersions.set(hubSession.id, timestamp(hubSession.updatedAt || hubSession.createdAt))
    this.sessionPolledAt.set(hubSession.id, Date.now())
  }

  #pollDesktopTaskIndex() {
    const path = join(this.dataRoot, "tasks-index.sqlite")
    if (!existsSync(path)) return
    const db = new DatabaseSync(path, { readOnly: true })
    let rows
    try {
      db.exec("PRAGMA busy_timeout=3000")
      rows = db.prepare("SELECT task_id, task_status, updated_at, title, workspace_path FROM tasks WHERE deleted = 0 AND archived = 0 ORDER BY updated_at DESC LIMIT 200").all()
    } finally { db.close() }
    for (const row of rows) {
      const id = String(row.task_id || "")
      if (!id) continue
      const current = { status: String(row.task_status || "").toLowerCase(), updatedAt: timestamp(row.updated_at) }
      const previous = this.indexSnapshot.get(id)
      this.indexSnapshot.set(id, current)
      if (this.subscriptions.has(id) || this.residentSessions.has(id)) continue
      if (!zcodeIndexCompletion(previous, current, this.monitorStartedAt)) continue
      const failed = current.status === "error" || current.status === "failed"
      const cancelled = current.status === "cancelled"
      this.emit("terminal", {
        version: 1, backend: "zcode", instanceId: ZCODE_INSTANCE_ID,
        id: `zcode-index:${id}:${current.updatedAt}`,
        turnId: `index:${current.updatedAt}`,
        type: failed ? "session.error" : cancelled ? "session.interrupted" : "session.idle",
        status: failed ? "failed" : cancelled ? "interrupted" : "completed",
        createdAt: new Date(current.updatedAt).toISOString(), sessionId: id,
        title: String(row.title || "ZCode session"), directory: String(row.workspace_path || ""),
        excerpt: failed || cancelled ? "" : zcodeLocalReply(this.dataRoot, id, current.updatedAt),
        error: failed ? "ZCode task failed" : null,
      })
    }
  }

  async #pollEvents() {
    if (this.monitorBusy) return
    if (this.monitorInitialized && Date.now() < this.backgroundPausedUntil) return
    this.monitorBusy = true
    try {
      try { this.#pollDesktopTaskIndex() } catch (error) { this.emit("diagnostic", `ZCode task index monitor failed: ${error.message}`) }
      const listedSessions = await this.listSessions({ limit: 200 })
      const sessionsById = new Map(listedSessions.map((session) => [session.id, session]))
      for (const [sessionId, info] of this.sessions) {
        if (!sessionsById.has(sessionId)) sessionsById.set(sessionId, zcodeSessionToHubSession(info))
      }
      const sessions = [...sessionsById.values()]
      const candidates = sessions.filter((session) => zcodeSessionNeedsEventPoll(session, {
        baseline: !this.monitorInitialized,
        previousVersion: this.sessionVersions.get(session.id),
        subscribed: this.subscriptions.has(session.id),
        resident: this.residentSessions.has(session.id),
        lastPolledAt: this.sessionPolledAt.get(session.id),
      }))
      for (let offset = 0; offset < candidates.length; offset += 8) {
        await Promise.allSettled(candidates.slice(offset, offset + 8).map((session) => this.#pollSessionEvents(session)))
      }
      this.monitorInitialized = true
    } finally { this.monitorBusy = false }
  }

  async startMonitor({ intervalMs = 5000 } = {}) {
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.monitorStartedAt = Date.now()
    void this.#pollEvents().catch((error) => this.emit("diagnostic", error.message))
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
    this.residentSessions.clear()
    this.sessionVersions.clear()
    this.sessionPolledAt.clear()
    if (child && child.exitCode === null && !child.killed) {
      child.stdin?.end?.()
      await new Promise((resolvePromise) => {
        const timer = setTimeout(() => { child.kill(); resolvePromise() }, 1000)
        child.once("exit", () => { clearTimeout(timer); resolvePromise() })
      })
    }
  }
}
