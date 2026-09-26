import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createI18n } from "./locales.mjs"
import { decodeSessionAction, encodeSessionAction, enterAgentMode, enterGlobalMode, filterAgentSessions, initializeAgentContext, migrateSessionCollections, selectAgentSession, sessionIdentity } from "./agent-context.mjs"
import { codexTaskStartedAt, codexThreadAppearsActive, elapsedDurationParts, isRunningStatus, openCodeTaskStartedAt, timestampMilliseconds } from "./dashboard.mjs"
import { SessionDiscoveryCache } from "./session-discovery-cache.mjs"
import { telegramMarkdownBody } from "./telegram-markdown.mjs"
import { approvalOptionsForRequest, approvalResponseForRequest, CodexAppServer, terminalEventFromNotification } from "../adapters/codex-app-server.mjs"
import { chooseOpenCodeQuestionOption, completeOpenCodeQuestion, nextOpenCodeQuestionIndex, normalizeOpenCodeQuestion, openCodeQuestionAnswers, openCodeQuestionToken, submitOpenCodeQuestion } from "../adapters/opencode-question.mjs"
import { ZCodeAppServer, zcodeTerminalEvent } from "../adapters/zcode-app-server.mjs"

const appDir = dirname(fileURLToPath(import.meta.url))
const dataRoot = process.env.AGENT_TASK_HUB_DATA_DIR || join(homedir(), ".config", "agent-task-hub")
const configPath = process.env.AGENT_TASK_HUB_CONFIG || join(dataRoot, "config.json")
const statePath = join(dataRoot, "state.json")
const instancesDir = join(dataRoot, "instances")
const eventsDir = join(dataRoot, "events")
const logsDir = join(dataRoot, "logs")
const lockPath = join(dataRoot, "controller.lock")
const decryptScript = join(appDir, "decrypt-token.ps1")
const credentialCache = new Map()
let i18n = createI18n("en-US")
const t = (key, ...args) => i18n.t(key, ...args)
let codexClient = null
let codexStartPromise = null
let codexLastError = null
let codexRetryAfter = 0
let codexDefaultCommand = process.env.AGENT_TASK_HUB_CODEX_COMMAND || "codex"
let codexDefaultTransport = process.env.AGENT_TASK_HUB_CODEX_TRANSPORT || "private"
let codexDefaultWsUrl = process.env.AGENT_TASK_HUB_CODEX_WS_URL || ""
let zcodeClient = null
let zcodeStartPromise = null
let zcodeLastError = null
let zcodeRetryAfter = 0
let zcodeDefaultBundle = process.env.AGENT_TASK_HUB_ZCODE_BUNDLE || ""
const sessionDiscoveryCache = new SessionDiscoveryCache({
  ttlMs: 8000,
  initialWaitMs: 1200,
  onError: (name, error) => log("WARN", `${name} session refresh unavailable: ${error?.message || error}`),
})
const openCodeEndpointHealth = new Map()
const codexActivityCache = new Map()
let instancesCache = { loadedAt: 0, items: [] }

async function ensureCodexClient(command = null, transport = null) {
  if (codexClient?.ready && codexClient.isRunning) return codexClient
  if (codexStartPromise) return codexStartPromise
  if (Date.now() < codexRetryAfter && codexLastError) throw codexLastError
  codexStartPromise = (async () => {
    const client = new CodexAppServer({
      command: command || codexDefaultCommand,
      transport: transport || codexDefaultTransport,
      wsUrl: codexDefaultWsUrl,
    })
    try {
      await client.start()
      codexClient = client
      codexLastError = null
      codexRetryAfter = 0
      client.once("exit", ({ detail }) => {
        if (codexClient === client) codexClient = null
        codexLastError = new Error(detail || "Codex app-server stopped")
        codexRetryAfter = Date.now() + 15000
      })
      return client
    } catch (error) {
      await client.stop().catch(() => {})
      codexLastError = error
      codexRetryAfter = Date.now() + 60000
      throw error
    } finally {
      codexStartPromise = null
    }
  })()
  return codexStartPromise
}

async function ensureZCodeClient(bundle = null) {
  if (zcodeClient?.ready && zcodeClient.isRunning) return zcodeClient
  if (zcodeStartPromise) return zcodeStartPromise
  if (Date.now() < zcodeRetryAfter && zcodeLastError) throw zcodeLastError
  zcodeStartPromise = (async () => {
    const client = new ZCodeAppServer({ bundle: bundle || zcodeDefaultBundle })
    try {
      await client.start()
      zcodeClient = client
      zcodeLastError = null
      zcodeRetryAfter = 0
      client.once("exit", ({ detail }) => {
        if (zcodeClient === client) zcodeClient = null
        zcodeLastError = new Error(detail || "ZCode app-server stopped")
        zcodeRetryAfter = Date.now() + 15000
      })
      return client
    } catch (error) {
      await client.stop().catch(() => {})
      zcodeLastError = error
      zcodeRetryAfter = Date.now() + 60000
      throw error
    } finally {
      zcodeStartPromise = null
    }
  })()
  return zcodeStartPromise
}

function cleanWindowsPowerShellEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key]
  return env
}

function ensureDirectories() {
  for (const dir of [dataRoot, instancesDir, eventsDir, logsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
  renameSync(temp, path)
}

function readJson(path, fallback = null) {
  try {
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function redact(value) {
  return String(value).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>").replace(/\d{8,12}:[A-Za-z0-9_-]{20,}/g, "<token-redacted>")
}

function log(level, message) {
  const path = join(logsDir, `bridge-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}.log`)
  writeFileSync(path, `${new Date().toISOString()} [${level}] ${redact(message)}\n`, { encoding: "utf8", flag: "a", mode: 0o600 })
}

function acquireLock() {
  try {
    const fd = openSync(lockPath, "wx", 0o600)
    writeFileSync(fd, String(process.pid))
    closeSync(fd)
  } catch (error) {
    const oldPid = Number.parseInt(readFileSync(lockPath, "utf8"), 10)
    let alive = false
    if (Number.isFinite(oldPid)) {
      try { process.kill(oldPid, 0); alive = true } catch {}
    }
    if (alive) throw new Error(`Another controller process is running, PID=${oldPid}`)
    rmSync(lockPath, { force: true })
    return acquireLock()
  }
}

function releaseLock() {
  try {
    const value = readFileSync(lockPath, "utf8").trim()
    if (value === String(process.pid)) rmSync(lockPath, { force: true })
  } catch {}
}

function decryptToken() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", decryptScript, "-ConfigPath", configPath], {
    encoding: "utf8",
    env: cleanWindowsPowerShellEnv(),
    windowsHide: true,
    timeout: 15000,
  })
  if (result.status !== 0) throw new Error(`Unable to decrypt Telegram token: ${redact(result.stderr || result.stdout)}`)
  const token = result.stdout.trim()
  if (!/^\d{8,12}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Invalid Telegram token format")
  return token
}

function decryptProtectedValue(value) {
  if (!value) return null
  if (credentialCache.has(value)) return credentialCache.get(value)
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$cipher=[Console]::In.ReadToEnd().Trim();$protected=[Convert]::FromBase64String($cipher);$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes));[Array]::Clear($bytes,0,$bytes.Length)"
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: String(value),
    encoding: "utf8",
    env: cleanWindowsPowerShellEnv(),
    windowsHide: true,
    timeout: 15000,
  })
  if (result.status !== 0) throw new Error("Unable to decrypt the local OpenCode credential")
  const plain = result.stdout
  credentialCache.set(value, plain)
  return plain
}

export function loopbackBase(value) {
  const url = new URL(String(value))
  const host = url.hostname.toLowerCase()
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Remote OpenCode endpoints are not allowed")
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

export function telegramApiRoot(value = "https://api.telegram.org") {
  const url = new URL(String(value || "https://api.telegram.org"))
  const host = url.hostname.toLowerCase()
  const official = url.protocol === "https:" && host === "api.telegram.org"
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(host)
  if (!official && !local) throw new Error("Telegram API root must be official HTTPS or a loopback test endpoint")
  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

export function parseCommand(text) {
  const value = String(text || "").trim()
  let match
  if (/^\/start(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "home" }
  if (/^\/home(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "home" }
  if (/^\/opencode(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "opencode" }
  if (/^\/codex(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "codex" }
  if (/^\/zcode(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "zcode" }
  if ((match = value.match(/^\/new(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9._-]{1,64})\s*\|\s*([\s\S]{1,3500})$/i))) return { name: "new", arg: { alias: match[1], prompt: match[2].trim() } }
  if (/^\/new(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(value)) return { name: "new", arg: null }
  if (/^\/help(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "help" }
  if (/^\/status(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "status" }
  if ((match = value.match(/^\/sessions(?:@[A-Za-z0-9_]+)?(?:\s+([1-9]\d{0,3}))?$/i))) return { name: "sessions", arg: Number.parseInt(match[1] || "1", 10) }
  if ((match = value.match(/^\/find(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,120})$/i))) return { name: "find", arg: match[1].trim() }
  if ((match = value.match(/^\/use(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,80})$/i))) return { name: "use", arg: match[1] }
  if (/^\/current(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "current" }
  if (/^\/show(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "show" }
  if ((match = value.match(/^\/send(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,3500})$/i))) return { name: "send", arg: match[1].trim() }
  if ((match = value.match(/^\/steer(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,3500})$/i))) return { name: "steer", arg: match[1].trim() }
  if ((match = value.match(/^\/add(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,3500})$/i))) return { name: "add", arg: match[1].trim() }
  if ((match = value.match(/^\/batch(?:@[A-Za-z0-9_]+)?\s+([\s\S]+)$/i))) return { name: "batch", arg: match[1].trim() }
  if (/^\/queue(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "queue" }
  if ((match = value.match(/^\/remove(?:@[A-Za-z0-9_]+)?\s+([1-9]\d{0,2})$/i))) return { name: "remove", arg: Number.parseInt(match[1], 10) }
  if (/^\/pause(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "pause" }
  if (/^\/resume(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "resume" }
  if (/^\/clearqueue(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "clearqueue" }
  if (/^\/stop(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "stop" }
  if (/^\/health(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "health" }
  if (/^\/approvals(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "approvals" }
  if (/^\/questions(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "questions" }
  if ((match = value.match(/^\/answer(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,1000})$/i))) return { name: "answer", arg: match[1].trim() }
  return null
}

export function resolveCodexProject(projects, alias) {
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) return null
  const requested = String(alias || "").toLowerCase()
  const key = Object.keys(projects).find((item) => item.toLowerCase() === requested)
  if (!key) return null
  const entry = projects[key]
  const directory = typeof entry === "string" ? entry : entry?.path
  if (!directory || !isAbsolute(String(directory))) return null
  return { alias: key, directory: resolve(String(directory)) }
}

export function parseBatch(value, limit = 20) {
  const parts = String(value || "").split(/^\s*---\s*$/m).map((part) => part.trim()).filter(Boolean)
  if (!parts.length) throw new Error(t("batchEmpty"))
  if (parts.length > limit) throw new Error(t("batchLimit", limit))
  if (parts.some((part) => part.length > 3500)) throw new Error(t("itemLimit"))
  return parts
}

function compact(text, max = 3600) {
  const value = String(text || "").replace(/\0/g, "").trim()
  return value.length > max ? `${value.slice(0, max)}\n${t("truncated")}` : value
}

export function permissionToken(serverUrl, requestId) {
  return createHash("sha256").update(`${loopbackBase(serverUrl)}\n${String(requestId)}`).digest("hex").slice(0, 16)
}

function permissionActionText(reply) {
  return ({ once: t("once"), always: t("always"), reject: t("reject") })[reply] || String(reply)
}

function permissionDetails(request) {
  const patterns = Array.isArray(request.patterns) ? request.patterns : request.pattern ? [request.pattern] : []
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {}
  const usefulMetadata = Object.entries(metadata)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) && String(value).trim())
    .slice(0, 6)
    .map(([key, value]) => `${key}：${compact(value, 500)}`)
  return compact([
    t("approvalTitle"),
    t("session", request.title || request.sessionId || t("unknownSession")),
    t("permission", request.permission || request.type || t("unknown")),
    patterns.length ? t("targets", patterns.slice(0, 10).map((item) => `• ${compact(item, 600)}`).join("\n")) : null,
    usefulMetadata.length ? t("details", usefulMetadata.join("\n")) : null,
    request.directory ? t("directory", request.directory) : null,
    t("approvalPrompt"),
  ].filter(Boolean).join("\n\n"), 3900)
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function durationText(start, end = Date.now()) {
  const duration = elapsedDurationParts(start, end)
  if (!duration) return t("unknownDuration")
  if (duration.days) return t("dayHourMinuteSeconds", duration.days, duration.hours, duration.minutes, duration.seconds)
  if (duration.hours) return t("hourMinuteSeconds", duration.hours, duration.minutes, duration.seconds)
  if (duration.minutes) return t("minuteSeconds", duration.minutes, duration.seconds)
  return t("seconds", duration.seconds)
}

function eventFingerprint(event) {
  const summary = event?.summary || {}
  return createHash("sha256").update(JSON.stringify({
    type: event?.type,
    sessionId: event?.sessionId,
    excerpt: event?.excerpt || "",
    error: event?.error || "",
    files: summary.files || 0,
    additions: summary.additions || 0,
    deletions: summary.deletions || 0,
  })).digest("hex").slice(0, 24)
}

export function clearRecoveredError(state, ...scopes) {
  if (!state?.lastError || !scopes.includes(state.lastError.scope)) return false
  state.lastError = null
  return true
}

async function requestJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.status === 204) return null
    return await response.json()
  } finally { clearTimeout(timer) }
}

function sessionUrl(session, path) {
  const base = loopbackBase(session.serverUrl)
  const query = new URLSearchParams({ directory: session.directory || "" })
  return `${base}${path}?${query}`
}

function findInstanceFor(session) {
  const base = loopbackBase(session.serverUrl)
  return loadInstances().find((item) => loopbackBase(item.serverUrl) === base && String(item.directory || "") === String(session.directory || ""))
    || loadInstances().find((item) => loopbackBase(item.serverUrl) === base)
}

function openCodeHeaders(session, headers = {}) {
  const source = session.auth ? session : findInstanceFor(session)
  if (!source?.auth?.passwordProtected) return { ...headers }
  if (source.auth.kind !== "windows-dpapi-basic") throw new Error("Unsupported local OpenCode authentication method")
  const username = source.auth.username || "opencode"
  const password = decryptProtectedValue(source.auth.passwordProtected)
  return { ...headers, authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` }
}

function requestSessionJson(session, path, options = {}, timeoutMs = 12000) {
  return requestJson(sessionUrl(session, path), { ...options, headers: openCodeHeaders(session, options.headers || {}) }, timeoutMs)
}

function loadInstances({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - instancesCache.loadedAt < 2000) return instancesCache.items
  const items = readdirSync(instancesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(join(instancesDir, entry.name)))
    .filter(Boolean)
    .filter((item) => now - Date.parse(item.updatedAt || 0) < 7 * 86400000)
    .filter((item) => {
      if (!Number.isInteger(Number(item.pid))) return true
      try { process.kill(Number(item.pid), 0); return true } catch { return false }
    })
    .filter((item) => { try { loopbackBase(item.serverUrl); return true } catch { return false } })
  instancesCache = { loadedAt: now, items }
  return items
}

function openCodeEndpointReady(base) {
  return Date.now() >= Number(openCodeEndpointHealth.get(base)?.retryAfter || 0)
}

function noteOpenCodeSuccess(base) {
  openCodeEndpointHealth.delete(base)
}

function noteOpenCodeFailure(base, error, scope = "session") {
  const previous = openCodeEndpointHealth.get(base) || { failures: 0, retryAfter: 0, loggedAt: 0 }
  const failures = Math.min(8, previous.failures + 1)
  const delay = Math.min(300000, 5000 * (2 ** Math.min(6, failures - 1)))
  const now = Date.now()
  openCodeEndpointHealth.set(base, { failures, retryAfter: now + delay, loggedAt: now })
  if (now - Number(previous.loggedAt || 0) >= 30000) log("WARN", `OpenCode ${scope} unavailable ${base}; retry in ${Math.ceil(delay / 1000)}s: ${error?.message || error}`)
}

async function discoverOpenCodeSessions() {
  const combined = new Map()
  const groups = new Map()
  for (const instance of loadInstances()) {
    const base = loopbackBase(instance.serverUrl)
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base).push(instance)
  }
  const results = await Promise.allSettled([...groups.entries()].map(async ([base, instances]) => {
    if (!openCodeEndpointReady(base)) return []
    const found = []
    for (const instance of instances) {
      const query = new URLSearchParams({ directory: instance.directory || "" })
      let sessions
      let statuses
      try {
        [sessions, statuses] = await Promise.all([
          requestJson(`${base}/session?${query}`, { headers: openCodeHeaders(instance) }, 1500),
          requestJson(`${base}/session/status?${query}`, { headers: openCodeHeaders(instance) }, 1500).catch(() => ({})),
        ])
      } catch (error) {
        noteOpenCodeFailure(base, error, "session scan")
        throw new Error(`${base}: ${error.message}`)
      }
      found.push(...(Array.isArray(sessions) ? sessions : []).map((info) => ({
          id: info.id,
          backend: "opencode",
          instanceId: instance.instanceId || null,
          title: info.title || t("unnamedSession"),
          directory: info.directory || instance.directory,
          updated: info.time?.updated || info.time?.created || 0,
          serverUrl: base,
          status: statuses?.[info.id]?.type || "idle",
          summary: info.summary || null,
          auth: instance.auth || null,
      })))
    }
    noteOpenCodeSuccess(base)
    return found
    }))
  for (const result of results) {
    if (result.status === "rejected") {
      continue
    }
    for (const item of result.value) {
      const previous = combined.get(item.id)
      if (!previous || item.updated > previous.updated) combined.set(item.id, item)
    }
  }
  return [...combined.values()].sort((a, b) => b.updated - a.updated)
}

async function discoverSessions({ force = false } = {}) {
  const [openCode, codex, zcode] = await Promise.all([
    sessionDiscoveryCache.get("OpenCode", discoverOpenCodeSessions, { force }),
    sessionDiscoveryCache.get("Codex", async () => {
      const client = await ensureCodexClient()
      return client.listSessions({ limit: 200 })
    }, { force }),
    sessionDiscoveryCache.get("ZCode", async () => {
      const client = await ensureZCodeClient()
      return client.listSessions({ limit: 200 })
    }, { force }),
  ])
  const updated = (item) => {
    let value = Number(item.updated || item.updatedAt || 0)
    if (value > 0 && value < 1e12) value *= 1000
    return value
  }
  return [...openCode, ...codex, ...zcode].sort((left, right) => updated(right) - updated(left))
}

function latestAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role !== "assistant") continue
    const value = (messages[i].parts || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").trim()
    if (value) return value
  }
  return t("noAssistantReply")
}

function workspacePathForZCode(workspace) {
  return String(workspace?.workspacePath || workspace?.path || workspace?.cwd || "")
}

function openCodeTimestamp(message) {
  let value = Number(message?.info?.time?.completed || message?.info?.time?.updated || message?.info?.time?.created || 0)
  if (value > 0 && value < 1e12) value *= 1000
  return value
}

function openCodeText(message) {
  return (message?.parts || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").trim()
}

export function openCodeTerminalEvent(session, messages, fallbackTime = Date.now()) {
  const list = Array.isArray(messages) ? messages : []
  const latestUser = list.filter((message) => message?.info?.role === "user")
    .sort((left, right) => openCodeTimestamp(right) - openCodeTimestamp(left))[0] || null
  const assistants = list
    .filter((message) => message?.info?.role === "assistant")
    .filter((message) => !latestUser || openCodeTimestamp(message) >= openCodeTimestamp(latestUser))
    .sort((left, right) => openCodeTimestamp(right) - openCodeTimestamp(left))
  const assistant = assistants[0] || null
  if (!assistant) return null
  const error = assistant?.info?.error || null
  const timestamp = openCodeTimestamp(assistant) || Number(session?.updated || 0) || fallbackTime
  const createdAt = new Date(timestamp > 0 && timestamp < 1e12 ? timestamp * 1000 : timestamp).toISOString()
  const fingerprint = createHash("sha256").update([
    session?.serverUrl || "",
    session?.id || "",
    assistant?.info?.id || "",
    String(timestamp),
    error ? "error" : "idle",
  ].join("\n")).digest("hex").slice(0, 24)
  return {
    version: 1,
    backend: "opencode",
    instanceId: session?.instanceId || null,
    id: `opencode-poll:${fingerprint}`,
    turnId: String(latestUser?.info?.id || assistant?.info?.id || ""),
    type: error ? "session.error" : "session.idle",
    createdAt,
    sessionId: String(session?.id || ""),
    title: session?.title || "OpenCode session",
    directory: session?.directory || "",
    serverUrl: session?.serverUrl || "",
    summary: session?.summary || null,
    excerpt: openCodeText(assistant).slice(0, 1800),
    error: error ? String(error?.data?.message || error?.message || error?.name || "OpenCode task failed").slice(0, 1000) : null,
  }
}

export function sessionStateIdentity(target) {
  return sessionIdentity({
    backend: target?.backend || "opencode",
    serverUrl: target?.serverUrl || null,
    instanceId: target?.instanceId || null,
    id: target?.sessionId || target?.id || "",
  })
}

async function getSessionView(session) {
  if ((session.backend || "opencode") === "codex") {
    const client = await ensureCodexClient()
    const thread = await client.readThread(session.id)
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const latestTurn = [...turns].reverse().find((turn) => Array.isArray(turn?.items))
    const latest = [...(latestTurn?.items || [])].reverse().find((item) => item?.type === "agentMessage" || item?.type === "exitedReviewMode")
    const status = await client.status(session.id)
    return compact(t("codexSessionView", thread?.name || thread?.preview || session.title, status, thread?.cwd || session.directory, turns.length, latest?.text || latest?.review || t("noAssistantReply")))
  }
  if (session.backend === "zcode") {
    const client = await ensureZCodeClient()
    const snapshot = await client.readSession(session.id, 12)
    const info = snapshot?.session || snapshot?.snapshot?.session || session
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : Array.isArray(snapshot?.snapshot?.messages) ? snapshot.snapshot.messages : []
    const latest = [...messages].reverse().find((item) => {
      const role = item?.role || item?.info?.role || item?.message?.role
      return role === "assistant" || item?.type === "assistant"
    })
    const latestText = latest?.content || latest?.text || latest?.message?.content
      || (latest?.parts || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n")
    return compact(t("zcodeSessionView", info?.title || session.title, info?.status || session.status, workspacePathForZCode(info?.workspace) || session.directory, info?.model?.modelId || t("none"), latestText || t("noAssistantReply")))
  }
  const id = encodeURIComponent(session.id)
  const [info, messages, todos, statuses] = await Promise.all([
    requestSessionJson(session, `/session/${id}`),
    requestJson(sessionUrl(session, `/session/${id}/message`) + "&limit=12", { headers: openCodeHeaders(session) }),
    requestSessionJson(session, `/session/${id}/todo`).catch(() => []),
    requestSessionJson(session, "/session/status").catch(() => ({})),
  ])
  const status = statuses?.[session.id]?.type || session.status || "idle"
  const pending = (Array.isArray(todos) ? todos : []).filter((todo) => !["completed", "cancelled"].includes(todo.status))
  const summary = info?.summary ? t("changes", info.summary.files || 0, info.summary.additions || 0, info.summary.deletions || 0) : t("noChanges")
  return compact(t("sessionView", info?.title || session.title, status, info?.directory || session.directory, summary, pending.length, latestAssistant(Array.isArray(messages) ? messages : [])))
}

async function main(options = {}) {
  ensureDirectories()
  if (!existsSync(configPath)) throw new Error(`Not configured: ${configPath}`)
  const config = readJson(configPath)
  codexDefaultCommand = config.codexCommand || process.env.AGENT_TASK_HUB_CODEX_COMMAND || "codex"
  codexDefaultTransport = config.codexTransport || process.env.AGENT_TASK_HUB_CODEX_TRANSPORT || "private"
  codexDefaultWsUrl = config.codexWsUrl || process.env.AGENT_TASK_HUB_CODEX_WS_URL || ""
  zcodeDefaultBundle = config.zcodeBundle || process.env.AGENT_TASK_HUB_ZCODE_BUNDLE || ""
  if (!config?.allowedUserId || !config?.allowedChatId || !config?.botTokenProtected) throw new Error("Incomplete Agent Task Hub configuration")
  i18n = createI18n(config.language || "en-US")
  const botToken = process.env.AGENT_TASK_HUB_BOT_TOKEN || decryptToken()
  const apiBase = `${telegramApiRoot(process.env.AGENT_TASK_HUB_TELEGRAM_API_ROOT)}/bot${botToken}`
  const botCommands = i18n.commands()
  const state = readJson(statePath, { updateOffset: 0, selected: null, sessionMap: [] })
  initializeAgentContext(state)
  state.queues ||= {}
  state.queueInFlight ||= {}
  state.queuePaused ||= {}
  state.queueStartOnIdle ||= {}
  state.processedEventIds ||= []
  state.recentEvents ||= {}
  state.sessionBrowser ||= { mode: "sessions", query: "", page: 1, backend: "all" }
  state.permissionRequests ||= {}
  state.openCodeQuestions ||= {}
  state.codexRequests ||= {}
  state.zcodeRequests ||= {}
  state.lastError ||= null
  const startedAt = new Date().toISOString()
  let telegramReady = false
  let telegramFailureCount = 0

  async function telegram(method, body = {}) {
    const response = await requestJson(`${apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, method === "getUpdates" ? 40000 : 15000)
    if (!response?.ok) throw new Error(`Telegram ${method} failed`)
    return response.result
  }

  async function send(text, extra = {}) {
    return telegram("sendMessage", {
      chat_id: String(config.allowedChatId),
      ...telegramMarkdownBody(compact(text, 3900), { link_preview_options: { is_disabled: true }, ...extra }),
    })
  }

  function noteForegroundActivity() {
    const quietMs = Math.max(2000, Number(config.foregroundQuietMs || 5000))
    codexClient?.deferBackgroundPoll?.(quietMs)
    zcodeClient?.deferBackgroundPoll?.(quietMs)
  }

  function codexRequestToken(message, client) {
    return createHash("sha256").update(`${client.connectionId}\n${String(message.id)}\n${message.method}\n${message.params?.threadId || ""}`).digest("hex").slice(0, 16)
  }

  function codexRequestText(request) {
    const params = request.params || {}
    const title = (state.sessionMap || []).find((item) => item.backend === "codex" && item.id === params.threadId)?.title || params.threadId || t("unknownSession")
    if (request.kind === "question") {
      const questions = (params.questions || []).map((question, index) => `${index + 1}. ${question.header ? `[${question.header}] ` : ""}${question.question}`).join("\n")
      return t("codexQuestion", title, questions)
    }
    const type = ({
      "item/commandExecution/requestApproval": t("codexCommandApproval"),
      "item/fileChange/requestApproval": t("codexFileApproval"),
      "item/permissions/requestApproval": t("codexPermissionApproval"),
    })[request.method] || request.method
    const detail = params.command ? (Array.isArray(params.command) ? params.command.join(" ") : params.command)
      : params.permissions ? JSON.stringify(params.permissions)
        : params.reason || t("none")
    return t("codexApproval", title, type, params.cwd || "", params.reason || "", compact(detail, 1200))
  }

  function codexRequestKeyboard(token, request) {
    if (request.kind === "question") {
      const rows = []
      for (const [questionIndex, question] of (request.params?.questions || []).entries()) {
        for (const [optionIndex, option] of (question.options || []).entries()) {
          rows.push([{ text: `${questionIndex + 1}. ${option.label}`.slice(0, 55), callback_data: `cqa:${token}:${questionIndex}:${optionIndex}` }])
        }
      }
      return { inline_keyboard: rows }
    }
    return { inline_keyboard: approvalOptionsForRequest(request.method, request.params).map((option) => [{ text: t(option.labelKey), callback_data: `cap:${token}:${option.action}` }]) }
  }

  async function sendCodexRequest(token, request, repeat = false) {
    const keyboard = codexRequestKeyboard(token, request)
    const message = await send(codexRequestText(request), keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {})
    request.lastPresentedAt = new Date().toISOString()
    if (!repeat || !request.notifiedAt) {
      request.notifiedAt = request.lastPresentedAt
      request.messageId = message?.message_id || null
      saveState()
    }
  }

  async function refreshCodexRequests() {
    if (!codexClient?.ready) return
    const pending = Object.entries(state.codexRequests)
      .filter(([, request]) => !request.resolvedAt && !request.notifiedAt && request.connectionId === codexClient.connectionId)
      .slice(0, 10)
    for (const [token, request] of pending) await sendCodexRequest(token, request)
  }

  async function handleCodexServerRequest(message, client) {
    if (message.method === "currentTime/read") {
      client.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) })
      return
    }
    const approvalMethods = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"])
    const question = message.method === "item/tool/requestUserInput"
    if (!approvalMethods.has(message.method) && !question) {
      client.respondError(message.id, -32601, "Agent Task Hub does not implement this app-server request")
      log("WARN", `unsupported Codex server request method=${message.method}`)
      return
    }
    const token = codexRequestToken(message, client)
    state.codexRequests[token] = {
      requestId: message.id,
      method: message.method,
      params: message.params || {},
      kind: question ? "question" : "approval",
      connectionId: client.connectionId,
      answers: {},
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      resolvedAt: null,
    }
    saveState()
    await sendCodexRequest(token, state.codexRequests[token])
  }

  function activeCodexRequest(token) {
    const request = state.codexRequests[token]
    if (!request || request.resolvedAt || !codexClient?.ready || request.connectionId !== codexClient.connectionId) throw new Error(t("codexRequestExpired"))
    return request
  }

  function completeCodexQuestionIfReady(request) {
    const questions = request.params?.questions || []
    if (!questions.length || questions.some((question) => !request.answers?.[question.id])) return false
    codexClient.respond(request.requestId, { answers: request.answers })
    request.resolvedAt = new Date().toISOString()
    request.resolution = "answered"
    saveState()
    return true
  }

  async function handleCodexTerminal(event) {
    const name = `${Date.now()}-${randomUUID()}.json`
    atomicJson(join(eventsDir, name), event)
  }

  async function attachCodexAdapter() {
    const client = await ensureCodexClient(config.codexCommand || null)
    if (client.agentTaskHubAttached) return client
    client.agentTaskHubAttached = true
    for (const request of Object.values(state.codexRequests)) {
      if (!request.resolvedAt && request.connectionId !== client.connectionId) {
        request.resolvedAt = new Date().toISOString()
        request.resolution = "connection-closed"
      }
    }
    saveState()
    client.on("terminal", (event) => { void handleCodexTerminal(event).catch((error) => recordError("codex-event", error)) })
    client.on("serverRequest", (message) => { void handleCodexServerRequest(message, client).catch((error) => recordError("codex-request", error)) })
    client.on("diagnostic", (message) => { if (message) log("INFO", `Codex app-server: ${message}`) })
    await client.startMonitor({ intervalMs: Number(config.codexPollIntervalMs || 15000), limit: Number(config.codexMonitorLimit || 30) })
    if (clearRecoveredError(state, "codex-reconnect", "codex-startup")) saveState()
    return client
  }

  function zcodeRequestToken(message, client) {
    return createHash("sha256").update(`${client.connectionId}\n${String(message.id)}\n${message.method}\n${message.params?.sessionId || ""}`).digest("hex").slice(0, 16)
  }

  function zcodeRequestText(request) {
    const params = request.params || {}
    const title = (state.sessionMap || []).find((item) => item.backend === "zcode" && item.id === params.sessionId)?.title || params.sessionId || t("unknownSession")
    if (request.kind === "question") {
      const questions = params.questions?.length ? params.questions : [{ header: t("question"), question: params.prompt || t("question"), options: [] }]
      return t("zcodeQuestion", title, questions.map((item, index) => `${index + 1}. ${item.header ? `[${item.header}] ` : ""}${item.question}`).join("\n"))
    }
    return t("zcodeApproval", title, params.toolName || t("unknown"), params.riskLevel || t("unknown"), params.reason || t("none"), compact(JSON.stringify(params.input ?? {}), 1200))
  }

  function zcodeRequestKeyboard(token, request) {
    if (request.kind === "approval") {
      const rows = (request.params?.options || []).map((option, index) => [{ text: String(option.name || option.kind || `${index + 1}`).slice(0, 55), callback_data: `zap:${token}:${index}` }])
      return { inline_keyboard: rows }
    }
    const rows = []
    const questions = request.params?.questions || []
    questions.forEach((question, questionIndex) => (question.options || []).forEach((option, optionIndex) => {
      rows.push([{ text: `${questionIndex + 1}. ${option.label}`.slice(0, 55), callback_data: `zqa:${token}:${questionIndex}:${optionIndex}` }])
    }))
    return { inline_keyboard: rows }
  }

  async function sendZCodeRequest(token, request, repeat = false) {
    const keyboard = zcodeRequestKeyboard(token, request)
    const message = await send(zcodeRequestText(request), keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {})
    request.lastPresentedAt = new Date().toISOString()
    if (!repeat || !request.notifiedAt) {
      request.notifiedAt = request.lastPresentedAt
      request.messageId = message?.message_id || null
      saveState()
    }
  }

  async function refreshZCodeRequests() {
    if (!zcodeClient?.ready) return
    const pending = Object.entries(state.zcodeRequests)
      .filter(([, request]) => !request.resolvedAt && !request.notifiedAt && request.connectionId === zcodeClient.connectionId)
      .slice(0, 10)
    for (const [token, request] of pending) await sendZCodeRequest(token, request)
  }

  async function handleZCodeServerRequest(message, client) {
    const kind = message.method === "interaction/requestPermission" ? "approval"
      : message.method === "interaction/requestUserInput" ? "question" : null
    if (!kind) {
      client.respondError(message.id, -32601, "Agent Task Hub does not implement this ZCode app-server request")
      log("WARN", `unsupported ZCode server request method=${message.method}`)
      return
    }
    const token = zcodeRequestToken(message, client)
    state.zcodeRequests[token] = {
      requestId: message.id,
      method: message.method,
      params: message.params || {},
      kind,
      connectionId: client.connectionId,
      answers: {},
      createdAt: new Date().toISOString(),
      notifiedAt: null,
      resolvedAt: null,
    }
    saveState()
    await sendZCodeRequest(token, state.zcodeRequests[token])
  }

  function activeZCodeRequest(token) {
    const request = state.zcodeRequests[token]
    if (!request || request.resolvedAt || !zcodeClient?.ready || request.connectionId !== zcodeClient.connectionId) throw new Error(t("zcodeRequestExpired"))
    return request
  }

  function completeZCodeQuestionIfReady(request) {
    const questions = request.params?.questions || []
    if (questions.length && questions.some((question) => !request.answers?.[question.question])) return false
    if (!questions.length && !request.answers?.answer) return false
    zcodeClient.respond(request.requestId, { action: "accept", content: questions.length ? { answers: request.answers } : { answer: request.answers.answer } })
    request.resolvedAt = new Date().toISOString()
    request.resolution = "answered"
    saveState()
    return true
  }

  async function attachZCodeAdapter() {
    const client = await ensureZCodeClient(config.zcodeBundle || null)
    if (client.agentTaskHubAttached) return client
    client.agentTaskHubAttached = true
    for (const request of Object.values(state.zcodeRequests)) {
      if (!request.resolvedAt && request.connectionId !== client.connectionId) {
        request.resolvedAt = new Date().toISOString()
        request.resolution = "connection-closed"
      }
    }
    saveState()
    client.on("terminal", (event) => { void handleCodexTerminal(event).catch((error) => recordError("zcode-event", error)) })
    client.on("serverRequest", (message) => { void handleZCodeServerRequest(message, client).catch((error) => recordError("zcode-request", error)) })
    client.on("diagnostic", (message) => { if (message) log("INFO", `ZCode app-server: ${message}`) })
    await client.startMonitor({ intervalMs: Number(config.zcodePollIntervalMs || 5000) })
    if (clearRecoveredError(state, "zcode-reconnect", "zcode-startup")) saveState()
    return client
  }

  const openCodeObserved = new Map()
  const openCodeMonitorStartedAt = Date.now()
  let openCodeMonitorInitialized = false

  async function pollOpenCodeTerminals() {
    const sessions = await discoverOpenCodeSessions()
    for (const session of sessions) {
      const key = sessionIdentity(session)
      let version = Number(session.updated || 0)
      if (version > 0 && version < 1e12) version *= 1000
      const current = { version, status: session.status || "idle" }
      const previous = openCodeObserved.get(key)
      if (!openCodeMonitorInitialized) {
        openCodeObserved.set(key, current)
        continue
      }
      const becameIdle = previous && previous.status !== "idle" && current.status === "idle"
      const changedWhileIdle = current.status === "idle" && previous && current.version > previous.version
      const recentNewSession = !previous && current.status === "idle" && current.version >= openCodeMonitorStartedAt - 2000
      if (!becameIdle && !changedWhileIdle && !recentNewSession) {
        openCodeObserved.set(key, current)
        continue
      }
      try {
        log("INFO", `OpenCode terminal candidate session=${session.id} status=${current.status}`)
        const messages = await recentSessionMessages(session, 12)
        const terminal = openCodeTerminalEvent(session, messages)
        if (terminal) await handleCodexTerminal(terminal)
        openCodeObserved.set(key, current)
      } catch (error) {
        log("WARN", `OpenCode terminal poll failed session=${session.id}: ${error.message}`)
      }
    }
    if (!openCodeMonitorInitialized) log("INFO", `OpenCode monitor baseline sessions=${sessions.length}`)
    openCodeMonitorInitialized = true
  }

  async function openCodeMonitorLoop() {
    while (true) {
      try { await pollOpenCodeTerminals() } catch (error) { recordError("opencode-monitor", error) }
      await sleep(Math.max(2000, Number(config.openCodePollIntervalMs || 5000)))
    }
  }

  function permissionKeyboard(token) {
    return { inline_keyboard: [
      [{ text: t("allowOnce"), callback_data: `perm:${token}:once` }],
      [{ text: t("allowSession"), callback_data: `perm:${token}:always` }],
      [{ text: t("deny"), callback_data: `perm:${token}:reject` }],
    ] }
  }

  async function sendPermissionRequest(token, request, repeat = false) {
    const message = await send(permissionDetails(request), { reply_markup: permissionKeyboard(token) })
    if (!repeat || !request.notifiedAt) {
      request.notifiedAt = new Date().toISOString()
      request.messageId = message?.message_id || null
      saveState()
    }
    return message
  }

  async function permissionTitle(request) {
    if (state.selected?.id === request.sessionId) return state.selected.title
    const cached = (state.sessionMap || []).find((item) => item.id === request.sessionId)
    if (cached?.title) return cached.title
    if (!request.sessionId) return t("openCodeSession")
    try {
      const info = await requestSessionJson(request, `/session/${encodeURIComponent(request.sessionId)}`)
      return info?.title || request.sessionId
    } catch {
      return request.sessionId
    }
  }

  async function discoverPendingPermissions() {
    const found = new Map()
    const checkedScopes = new Set()
    const unique = new Map()
    for (const instance of loadInstances()) {
      const base = loopbackBase(instance.serverUrl)
      const scope = `${base}\n${String(instance.directory || "")}`
      if (!unique.has(scope)) unique.set(scope, instance)
    }
    for (const instance of unique.values()) {
      const base = loopbackBase(instance.serverUrl)
      if (!openCodeEndpointReady(base)) continue
      const directory = String(instance.directory || "")
      const scope = `${base}\n${directory}`
      try {
        const query = new URLSearchParams({ directory })
        const list = await requestJson(`${base}/permission?${query}`, { headers: openCodeHeaders(instance) }, 1500)
        noteOpenCodeSuccess(base)
        checkedScopes.add(scope)
        for (const raw of Array.isArray(list) ? list : []) {
          if (!raw?.id) continue
          const token = permissionToken(base, raw.id)
          const previous = found.get(token)
          if (previous) {
            if (!previous.candidateDirectories.includes(directory)) previous.candidateDirectories.push(directory)
            continue
          }
          const request = {
            requestId: String(raw.id),
            sessionId: raw.sessionID ? String(raw.sessionID) : null,
            permission: String(raw.permission || raw.type || "unknown"),
            patterns: Array.isArray(raw.patterns) ? raw.patterns.map(String) : raw.pattern ? [String(raw.pattern)] : [],
            always: Array.isArray(raw.always) ? raw.always.map(String) : [],
            metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
            serverUrl: base,
            directory,
            candidateDirectories: [directory],
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          }
          request.title = await permissionTitle(request)
          found.set(token, request)
        }
      } catch (error) {
        noteOpenCodeFailure(base, error, "permission scan")
      }
    }
    return { found, checkedScopes }
  }

  async function refreshPermissions() {
    const { found, checkedScopes } = await discoverPendingPermissions()
    const now = new Date().toISOString()
    let changed = false
    for (const [token, current] of found) {
      const existing = state.permissionRequests[token]
      if (existing?.resolvedAt) continue
      if (existing) {
        Object.assign(existing, current, {
          firstSeenAt: existing.firstSeenAt || current.firstSeenAt,
          lastSeenAt: existing.lastSeenAt || current.lastSeenAt,
          notifiedAt: existing.notifiedAt || null,
          messageId: existing.messageId || null,
        })
        if (existing.absentSince) {
          delete existing.absentSince
          changed = true
        }
      } else {
        state.permissionRequests[token] = current
        changed = true
      }
      if (Date.now() - Date.parse(state.permissionRequests[token].lastSeenAt || 0) >= 60000) {
        state.permissionRequests[token].lastSeenAt = now
        changed = true
      }
      if (!state.permissionRequests[token].notifiedAt) await sendPermissionRequest(token, state.permissionRequests[token])
    }
    for (const [token, request] of Object.entries(state.permissionRequests)) {
      if (request.resolvedAt || found.has(token)) continue
      const scopes = (request.candidateDirectories || [request.directory || ""]).map((directory) => `${loopbackBase(request.serverUrl)}\n${directory}`)
      if (!scopes.some((scope) => checkedScopes.has(scope))) continue
      if (!request.absentSince) {
        request.absentSince = now
        changed = true
      }
      if (Date.now() - Date.parse(request.absentSince) >= 30000) {
        request.resolvedAt = now
        request.resolution = "external"
        changed = true
      }
    }
    const cutoff = Date.now() - 7 * 86400000
    for (const [token, request] of Object.entries(state.permissionRequests)) {
      if (request.resolvedAt && Date.parse(request.resolvedAt) < cutoff) {
        delete state.permissionRequests[token]
        changed = true
      }
    }
    if (changed) saveState()
    return found
  }

  async function replyToPermission(request, reply) {
    const directories = [...new Set(request.candidateDirectories || [request.directory || ""])]
    let lastError = null
    for (const directory of directories) {
      const target = { serverUrl: request.serverUrl, directory }
      try {
        await requestSessionJson(target, `/permission/${encodeURIComponent(request.requestId)}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reply }),
        })
        return
      } catch (error) {
        lastError = error
        if (!/HTTP 404\b/.test(error.message)) throw error
      }
      if (request.sessionId) {
        try {
          await requestSessionJson(target, `/session/${encodeURIComponent(request.sessionId)}/permissions/${encodeURIComponent(request.requestId)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response: reply }),
          })
          return
        } catch (error) {
          lastError = error
          if (!/HTTP 404\b/.test(error.message)) throw error
        }
      }
    }
    throw lastError || new Error(t("approvalExpired"))
  }

  function openCodeQuestionText(request) {
    const index = nextOpenCodeQuestionIndex(request)
    if (index < 0) return t("openCodeQuestionAnswered")
    const question = request.questions[index]
    const selected = new Set(request.answers?.[index] || [])
    const options = question.options.map((option, optionIndex) => {
      const mark = selected.has(option.label) ? "✅" : `${optionIndex + 1}.`
      return `${mark} ${option.label}${option.description ? ` — ${option.description}` : ""}`
    }).join("\n")
    return compact(t(
      "openCodeQuestion",
      request.title || request.sessionId || t("unknownSession"),
      request.directory || "",
      index + 1,
      request.questions.length,
      question.header || t("question"),
      question.question,
      options || t("noOptions"),
      question.multiple ? t("multiChoiceHint") : question.custom || !question.options.length ? t("customAnswerHint") : t("singleChoiceHint"),
    ), 3900)
  }

  function openCodeQuestionKeyboard(token, request) {
    const index = nextOpenCodeQuestionIndex(request)
    if (index < 0) return { inline_keyboard: [] }
    const question = request.questions[index]
    const selected = new Set(request.answers?.[index] || [])
    const rows = question.options.map((option, optionIndex) => [{
      text: `${selected.has(option.label) ? "✅ " : ""}${option.label}`.slice(0, 55),
      callback_data: `oqa:${token}:${index}:${optionIndex}`,
    }])
    if (question.multiple) rows.push([{ text: t("submitChoice"), callback_data: `oqs:${token}:${index}` }])
    rows.push([{ text: t("rejectQuestion"), callback_data: `oqr:${token}` }])
    return { inline_keyboard: rows }
  }

  async function sendOpenCodeQuestion(token, request, repeat = false) {
    const message = await send(openCodeQuestionText(request), { reply_markup: openCodeQuestionKeyboard(token, request) })
    const now = new Date().toISOString()
    request.lastPresentedAt = now
    if (!repeat || !request.notifiedAt) request.notifiedAt = now
    request.messageId = message?.message_id || request.messageId || null
    saveState()
    return message
  }

  async function discoverPendingOpenCodeQuestions() {
    const found = new Map()
    const checkedScopes = new Set()
    const unique = new Map()
    for (const instance of loadInstances()) {
      const base = loopbackBase(instance.serverUrl)
      const scope = `${base}\n${String(instance.directory || "")}`
      if (!unique.has(scope)) unique.set(scope, instance)
    }
    for (const instance of unique.values()) {
      const base = loopbackBase(instance.serverUrl)
      if (!openCodeEndpointReady(base)) continue
      const directory = String(instance.directory || "")
      const scope = `${base}\n${directory}`
      try {
        const query = new URLSearchParams({ directory })
        const list = await requestJson(`${base}/question?${query}`, { headers: openCodeHeaders(instance) }, 1500)
        noteOpenCodeSuccess(base)
        checkedScopes.add(scope)
        for (const raw of Array.isArray(list) ? list : []) {
          const normalized = normalizeOpenCodeQuestion(raw)
          if (!normalized) continue
          const token = openCodeQuestionToken(base, normalized.requestId)
          const previous = found.get(token)
          if (previous) {
            if (!previous.candidateDirectories.includes(directory)) previous.candidateDirectories.push(directory)
            continue
          }
          const request = {
            ...normalized,
            serverUrl: base,
            directory,
            candidateDirectories: [directory],
            answers: {},
            completedQuestions: {},
            firstSeenAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          }
          request.title = await permissionTitle(request)
          found.set(token, request)
        }
      } catch (error) {
        noteOpenCodeFailure(base, error, "question scan")
      }
    }
    return { found, checkedScopes }
  }

  async function refreshOpenCodeQuestions() {
    const { found, checkedScopes } = await discoverPendingOpenCodeQuestions()
    const now = new Date().toISOString()
    let changed = false
    for (const [token, current] of found) {
      const existing = state.openCodeQuestions[token]
      if (existing?.resolvedAt) continue
      if (existing) {
        const previousMetadata = JSON.stringify({ questions: existing.questions, title: existing.title, directory: existing.directory, candidateDirectories: existing.candidateDirectories })
        Object.assign(existing, current, {
          answers: existing.answers || {},
          completedQuestions: existing.completedQuestions || {},
          firstSeenAt: existing.firstSeenAt || current.firstSeenAt,
          lastSeenAt: now,
          notifiedAt: existing.notifiedAt || null,
          lastPresentedAt: existing.lastPresentedAt || null,
          messageId: existing.messageId || null,
        })
        if (existing.absentSince) {
          delete existing.absentSince
          changed = true
        }
        const currentMetadata = JSON.stringify({ questions: existing.questions, title: existing.title, directory: existing.directory, candidateDirectories: existing.candidateDirectories })
        if (previousMetadata !== currentMetadata) changed = true
      } else {
        state.openCodeQuestions[token] = current
        changed = true
      }
      if (!state.openCodeQuestions[token].notifiedAt) await sendOpenCodeQuestion(token, state.openCodeQuestions[token])
    }
    for (const [token, request] of Object.entries(state.openCodeQuestions)) {
      if (request.resolvedAt || found.has(token)) continue
      const scopes = (request.candidateDirectories || [request.directory || ""]).map((directory) => `${loopbackBase(request.serverUrl)}\n${directory}`)
      if (!scopes.some((scope) => checkedScopes.has(scope))) continue
      if (!request.absentSince) {
        request.absentSince = now
        changed = true
      } else if (Date.now() - Date.parse(request.absentSince) >= 30000) {
        request.resolvedAt = now
        request.resolution = "external"
        changed = true
      }
    }
    const cutoff = Date.now() - 7 * 86400000
    for (const [token, request] of Object.entries(state.openCodeQuestions)) {
      if (request.resolvedAt && Date.parse(request.resolvedAt) < cutoff) {
        delete state.openCodeQuestions[token]
        changed = true
      }
    }
    if (changed) saveState()
    return found
  }

  function activeOpenCodeQuestion(token) {
    const request = state.openCodeQuestions[token]
    if (!request || request.resolvedAt) throw new Error(t("questionExpired"))
    return request
  }

  async function postOpenCodeQuestion(request, action, body = null) {
    const directories = [...new Set(request.candidateDirectories || [request.directory || ""])]
    let lastError = null
    for (const directory of directories) {
      try {
        const target = { serverUrl: request.serverUrl, directory }
        await submitOpenCodeQuestion({
          serverUrl: loopbackBase(request.serverUrl),
          directory,
          requestId: request.requestId,
          action,
          answers: body?.answers || null,
          headers: openCodeHeaders(target),
        })
        return
      } catch (error) {
        lastError = error
        if (!/HTTP 404\b/.test(error.message)) throw error
      }
    }
    throw lastError || new Error(t("questionExpired"))
  }

  async function finishOpenCodeQuestion(request) {
    const answers = openCodeQuestionAnswers(request)
    if (!answers) return false
    await postOpenCodeQuestion(request, "reply", { answers })
    request.resolvedAt = new Date().toISOString()
    request.resolution = "answered"
    saveState()
    return true
  }

  function authorizedMessage(message) {
    return message?.chat?.type === "private" && String(message.from?.id) === String(config.allowedUserId) && String(message.chat?.id) === String(config.allowedChatId)
  }

  function authorizedCallback(query) {
    return query?.message?.chat?.type === "private"
      && String(query.from?.id) === String(config.allowedUserId)
      && String(query.message.chat?.id) === String(config.allowedChatId)
  }

  function saveState() { atomicJson(statePath, state) }

  function sessionStateKey(target) {
    return sessionStateIdentity(target)
  }

  function migrateSessionState(target) {
    return migrateSessionCollections(state, {
      backend: target?.backend || "opencode",
      serverUrl: target?.serverUrl || null,
      instanceId: target?.instanceId || null,
      id: target?.sessionId || target?.id || "",
    })
  }

  function recordError(scope, error) {
    state.lastError = { scope, message: compact(error?.message || error, 500), at: new Date().toISOString() }
    saveState()
  }

  function rememberEvent(event) {
    const id = String(event.id || "")
    if (id && !state.processedEventIds.includes(id)) state.processedEventIds.push(id)
    state.processedEventIds = state.processedEventIds.slice(-500)
    if (event.sessionId) state.recentEvents[migrateSessionState(event)] = { fingerprint: eventFingerprint(event), turnId: event.turnId || null, at: event.createdAt || new Date().toISOString() }
    saveState()
  }

  function eventAlreadyHandled(event, activeQueueItem = null) {
    if (event.id && state.processedEventIds.includes(String(event.id))) return true
    const recent = event.sessionId ? state.recentEvents[migrateSessionState(event)] : null
    if (event.turnId && recent?.turnId === event.turnId) return true
    if (activeQueueItem && Date.parse(event.createdAt || 0) >= Date.parse(activeQueueItem.dispatchedAt || 0)) return false
    return Boolean(recent
      && recent.fingerprint === eventFingerprint(event)
      && Math.abs(Date.parse(event.createdAt || 0) - Date.parse(recent.at || 0)) < 15000)
  }

  function waitingQueue(session) {
    const key = migrateSessionState(session)
    if (!Array.isArray(state.queues[key])) state.queues[key] = []
    return state.queues[key]
  }

  async function currentSessionStatus(session) {
    try {
      if ((session.backend || "opencode") === "codex") {
        const client = await ensureCodexClient(config.codexCommand || null)
        return await client.status(session.id)
      }
      if (session.backend === "zcode") {
        const client = await ensureZCodeClient(config.zcodeBundle || null)
        return await client.status(session.id)
      }
      const statuses = await requestSessionJson(session, "/session/status")
      return statuses?.[session.id]?.type || "idle"
    } catch {
      return "unavailable"
    }
  }

  async function dispatchNext(session) {
    const key = migrateSessionState(session)
    const queue = waitingQueue(session)
    if (state.queuePaused[key] || state.queueInFlight[key] || queue.length === 0) return null
    const item = queue.shift()
    item.dispatchedAt = new Date().toISOString()
    item.dispatchState = "dispatching"
    state.queueInFlight[key] = item
    state.queueStartOnIdle[key] = false
    saveState()
    try {
      if ((session.backend || "opencode") === "codex") {
        const client = await ensureCodexClient(config.codexCommand || null)
        const turn = await client.sendPrompt(session.id, item.text)
        item.turnId = turn?.id || null
      } else if (session.backend === "zcode") {
        const client = await ensureZCodeClient(config.zcodeBundle || null)
        const turn = await client.sendPrompt(session.id, item.text)
        item.turnId = turn?.id || null
      } else {
        await requestSessionJson(session, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: item.text }] }),
        })
      }
      item.dispatchState = "sent"
      item.sentAt = new Date().toISOString()
      state.queueInFlight[key] = item
      saveState()
      log("AUDIT", `queue dispatched session=${session.id} item=${item.id} remaining=${queue.length}`)
      return { item, remaining: queue.length }
    } catch (error) {
      queue.unshift(item)
      delete state.queueInFlight[key]
      saveState()
      throw error
    }
  }

  async function queueVisibleCodexTurn(session, text, status = "busy") {
    const key = migrateSessionState(session)
    const queue = waitingQueue(session)
    const limit = Number(config.queueLimit || 20)
    const occupied = queue.length + (state.queueInFlight[key] ? 1 : 0)
    if (occupied >= limit) return send(t("queueFull", limit))
    const [item] = makeQueueItems([text])
    item.source = "send"
    queue.push(item)
    state.queueStartOnIdle[key] = true
    saveState()
    return send(t("sendQueuedVisible", status, queue.length))
  }

  function queueSummary(session) {
    const key = migrateSessionState(session)
    const queue = waitingQueue(session)
    const active = state.queueInFlight[key]
    const paused = Boolean(state.queuePaused[key])
    const lines = [
      t("queueState", paused ? t("queuePaused") : t("queueAutomatic")),
      t("activeQueue", active ? `${active.batchTotal > 1 ? `[${active.batchIndex}/${active.batchTotal}] ` : ""}${active.text}` : t("none")),
      active?.dispatchedAt ? t("elapsed", durationText(active.dispatchedAt)) : null,
      t("waitingCount", queue.length),
    ].filter(Boolean)
    queue.forEach((item, index) => lines.push(`${index + 1}. ${item.batchTotal > 1 ? `[${item.batchIndex}/${item.batchTotal}] ` : ""}${compact(item.text, 240)}`))
    return compact(lines.join("\n"))
  }

  function makeQueueItems(parts) {
    const batchId = randomUUID()
    const createdAt = new Date().toISOString()
    return parts.map((text, index) => ({
      id: randomUUID(),
      batchId,
      batchIndex: index + 1,
      batchTotal: parts.length,
      text,
      createdAt,
    }))
  }

  async function healthText() {
    const instances = loadInstances()
    let sessions = []
    let openCode = t("offline")
    try {
      sessions = await discoverSessions()
      openCode = instances.length ? t("online") : t("unregistered")
    } catch (error) {
      recordError("health", error)
    }
    const waiting = Object.values(state.queues).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0)
    const running = Object.keys(state.queueInFlight).length
    const paused = Object.values(state.queuePaused).filter(Boolean).length
    const lastError = state.lastError ? `${state.lastError.at} [${state.lastError.scope}] ${state.lastError.message}` : t("none")
    const approvals = Object.values(state.permissionRequests).filter((item) => !item.resolvedAt).length
      + Object.values(state.openCodeQuestions).filter((item) => !item.resolvedAt).length
      + Object.values(state.codexRequests).filter((item) => !item.resolvedAt).length
      + Object.values(state.zcodeRequests).filter((item) => !item.resolvedAt).length
    const codex = codexClient?.ready && codexClient.isRunning
      ? `${t("online")} · ${t(String(codexClient.transport || "").startsWith("shared") ? "codexShared" : "codexPrivate")}`
      : t("offline")
    const zcode = zcodeClient?.ready && zcodeClient.isRunning ? t("online") : t("offline")
    return compact(t("health", openCode, codex, zcode, instances.length, sessions.length, state.selected?.title || t("notSelected"), approvals, running, waiting, paused, durationText(startedAt), lastError))
  }

  function backendText(backend) {
    return backend === "codex" ? t("agentCodex") : backend === "zcode" ? t("agentZCode") : t("agentOpenCode")
  }

  function modeText() {
    if (state.viewMode !== "agent") return t("globalMode")
    return state.activeBackend === "codex" ? t("codexMode") : state.activeBackend === "zcode" ? t("zcodeMode") : t("openCodeMode")
  }

  function shortLine(value, max = 90) {
    const text = String(value || "").replace(/[\r\n]+/g, " ").trim()
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
  }

  function requestCounts(backend) {
    if (backend === "opencode") return {
      approvals: Object.values(state.permissionRequests).filter((item) => !item.resolvedAt).length,
      questions: Object.values(state.openCodeQuestions).filter((item) => !item.resolvedAt).length,
    }
    const requests = backend === "zcode"
      ? Object.values(state.zcodeRequests).filter((item) => !item.resolvedAt && item.connectionId === zcodeClient?.connectionId)
      : Object.values(state.codexRequests).filter((item) => !item.resolvedAt && item.connectionId === codexClient?.connectionId)
    return {
      approvals: requests.filter((item) => item.kind === "approval").length,
      questions: requests.filter((item) => item.kind === "question").length,
    }
  }

  function sessionBlocker(session) {
    const backend = session.backend || "opencode"
    let approval = false
    let question = false
    if (backend === "opencode") {
      approval = Object.values(state.permissionRequests).some((item) => !item.resolvedAt && item.sessionId === session.id)
      question = Object.values(state.openCodeQuestions).some((item) => !item.resolvedAt && item.sessionId === session.id)
    } else if (backend === "codex") {
      const requests = Object.values(state.codexRequests).filter((item) => !item.resolvedAt && item.connectionId === codexClient?.connectionId && item.params?.threadId === session.id)
      approval = requests.some((item) => item.kind === "approval")
      question = requests.some((item) => item.kind === "question")
    } else {
      const requests = Object.values(state.zcodeRequests).filter((item) => !item.resolvedAt && item.connectionId === zcodeClient?.connectionId && item.params?.sessionId === session.id)
      approval = requests.some((item) => item.kind === "approval")
      question = requests.some((item) => item.kind === "question")
    }
    if (approval && question) return t("homeWaitingBoth")
    if (approval) return t("homeWaitingApproval")
    if (question) return t("homeWaitingQuestion")
    return ""
  }

  async function taskStartedAt(session) {
    const key = migrateSessionState(session)
    const queued = state.queueInFlight[key]
    const queuedAt = timestampMilliseconds(queued?.dispatchedAt || queued?.sentAt)
    if (queuedAt > 0) return queuedAt
    if (Number(session.dashboardStartedAt) > 0) return Number(session.dashboardStartedAt)
    try {
      if ((session.backend || "opencode") === "codex") {
        const client = await ensureCodexClient(config.codexCommand || null)
        return codexTaskStartedAt(await client.readThread(session.id))
      }
      if (session.backend === "zcode") return timestampMilliseconds(session.dashboardStartedAt)
      return openCodeTaskStartedAt(await recentSessionMessages(session, 30))
    } catch (error) {
      log("WARN", `dashboard timing unavailable backend=${session.backend || "opencode"} session=${session.id}: ${error.message}`)
      return 0
    }
  }

  function waitingCountForSessions(sessions) {
    return sessions.reduce((sum, session) => {
      const queue = state.queues[migrateSessionState(session)]
      return sum + (Array.isArray(queue) ? queue.length : 0)
    }, 0)
  }

  async function enrichCodexDashboardActivity(allSessions) {
    const codexSessions = filterAgentSessions(allSessions, "codex")
    const alreadyRunning = new Set(codexSessions.filter((session) => isRunningStatus(session.status)).map((session) => session.id))
    const preferredIds = new Set()
    if (state.selected?.backend === "codex") preferredIds.add(state.selected.id)
    for (const [key, item] of Object.entries(state.queueInFlight)) if (key.startsWith("codex:") && item) preferredIds.add(key.slice(key.lastIndexOf(":") + 1))
    for (const request of Object.values(state.codexRequests)) if (!request.resolvedAt && request.params?.threadId) preferredIds.add(String(request.params.threadId))
    const probeLimit = Math.max(3, Math.min(12, Number(config.dashboardCodexProbeLimit || 8)))
    const candidates = codexSessions
      .filter((session) => !alreadyRunning.has(session.id))
      .sort((left, right) => {
        const preferred = Number(preferredIds.has(right.id)) - Number(preferredIds.has(left.id))
        if (preferred) return preferred
        return Number(right.updatedAt || 0) - Number(left.updatedAt || 0)
      })
      .slice(0, probeLimit)
    if (!candidates.length) return allSessions
    const client = codexClient?.ready && codexClient.isRunning ? codexClient : null
    if (!client) return allSessions
    const now = Date.now()
    const refreshes = []
    for (const session of candidates) {
      const cached = codexActivityCache.get(session.id)
      if (cached?.active) {
        session.status = "busy"
        session.dashboardStartedAt = cached.startedAt
        session.activeTurnId = cached.activeTurnId || session.activeTurnId || null
      }
      if (cached?.inFlight || now - Number(cached?.checkedAt || 0) < 5000) continue
      const entry = cached || { active: false, startedAt: 0, activeTurnId: null, checkedAt: 0, inFlight: null }
      entry.inFlight = client.readThread(session.id)
        .then((thread) => {
          entry.active = codexThreadAppearsActive(thread)
          entry.startedAt = entry.active ? codexTaskStartedAt(thread) : 0
          entry.activeTurnId = entry.active ? thread?.turns?.at(-1)?.id || null : null
          entry.checkedAt = Date.now()
        })
        .catch((error) => {
          entry.checkedAt = Date.now()
          log("WARN", `Codex dashboard probe failed session=${session.id}: ${error.message}`)
        })
        .finally(() => { entry.inFlight = null })
      codexActivityCache.set(session.id, entry)
      refreshes.push(entry.inFlight)
    }
    if (refreshes.length) await Promise.race([Promise.allSettled(refreshes), sleep(700)])
    for (const session of candidates) {
      const cached = codexActivityCache.get(session.id)
      if (!cached?.active) continue
      session.status = "busy"
      session.dashboardStartedAt = cached.startedAt
      session.activeTurnId = cached.activeTurnId || session.activeTurnId || null
    }
    return allSessions
  }

  async function homeAgentSection(allSessions, backend) {
    const sessions = filterAgentSessions(allSessions, backend)
    const running = sessions.filter((session) => isRunningStatus(session.status))
    const visible = running.slice(0, 3)
    const starts = await Promise.all(visible.map((session) => taskStartedAt(session)))
    const online = backend === "opencode" ? loadInstances().length > 0
      : backend === "codex" ? Boolean(codexClient?.ready && codexClient.isRunning)
        : Boolean(zcodeClient?.ready && zcodeClient.isRunning)
    const lines = [t("homeAgentSummary", online ? "🟢" : "🔴", backendText(backend), running.length, waitingCountForSessions(sessions), sessions.length)]
    if (!visible.length) lines.push(t("homeNoRunning"))
    visible.forEach((session, index) => {
      const start = starts[index]
      const elapsed = start ? durationText(new Date(start).toISOString()) : t("unknownDuration")
      const blocker = sessionBlocker(session)
      lines.push(t("homeRunningTask", index + 1, shortLine(session.title, 100), elapsed, blocker ? t("homeBlocked", blocker) : "", shortLine(session.directory, 110) || t("none")))
    })
    if (running.length > visible.length) lines.push(t("homeMoreRunning", running.length - visible.length))
    return { text: lines.join("\n"), running }
  }

  function homeKeyboard(activeSessions = []) {
    const rows = [
      [{ text: t("buttonOpenCode"), callback_data: "agent:opencode" }, { text: t("buttonCodex"), callback_data: "agent:codex" }, { text: t("buttonZCode"), callback_data: "agent:zcode" }],
    ]
    for (const session of activeSessions.slice(0, 4)) rows.push([{
      text: `▶ ${backendText(session.backend)} · ${shortLine(session.title, 38)}`,
      callback_data: encodeSessionAction("select", session),
    }])
    rows.push([{ text: t("buttonAllSessions"), callback_data: "allsessions" }, { text: t("refresh"), callback_data: "home" }])
    return { inline_keyboard: rows }
  }

  async function buildHomePayload() {
    const sessions = await enrichCodexDashboardActivity(await discoverSessions())
    const [openCode, codex, zcode] = await Promise.all([homeAgentSection(sessions, "opencode"), homeAgentSection(sessions, "codex"), homeAgentSection(sessions, "zcode")])
    const openRequests = requestCounts("opencode")
    const codexRequests = requestCounts("codex")
    const zcodeRequests = requestCounts("zcode")
    const requestSummary = t("homePendingRequests", t("homeRequestCount", openRequests.approvals, openRequests.questions), t("homeRequestCount", codexRequests.approvals, codexRequests.questions), t("homeRequestCount", zcodeRequests.approvals, zcodeRequests.questions))
    const selected = state.selected ? `${backendText(state.selected.backend)} · ${state.selected.title}` : t("notSelected")
    const lastError = state.lastError ? t("homeRecentError", state.lastError.scope, shortLine(state.lastError.message, 180)) : ""
    const text = [t("homeTitle"), t("homeSelected", selected), requestSummary, openCode.text, codex.text, zcode.text, lastError].filter(Boolean).join("\n\n")
    return { text, reply_markup: homeKeyboard([...openCode.running, ...codex.running, ...zcode.running]), sessions, running: [...openCode.running, ...codex.running, ...zcode.running] }
  }

  async function commandHome() {
    enterGlobalMode(state)
    const payload = await buildHomePayload()
    saveState()
    return send(payload.text, { reply_markup: payload.reply_markup })
  }

  async function commandAgent(backend) {
    enterAgentMode(state, backend)
    if (backend === "codex") {
      saveState()
      try {
        await attachCodexAdapter()
        return commandSessions(1, "", "codex")
      } catch (error) {
        return send(t("codexUnavailable", compact(error.message, 300)), { reply_markup: { inline_keyboard: [[{ text: t("buttonHome"), callback_data: "home" }, { text: t("buttonOpenCode"), callback_data: "agent:opencode" }]] } })
      }
    }
    if (backend === "zcode") {
      saveState()
      try {
        await attachZCodeAdapter()
        return commandSessions(1, "", "zcode")
      } catch (error) {
        return send(t("zcodeUnavailable", compact(error.message, 300)), { reply_markup: { inline_keyboard: [[{ text: t("buttonHome"), callback_data: "home" }, { text: t("buttonOpenCode"), callback_data: "agent:opencode" }]] } })
      }
    }
    saveState()
    return commandSessions(1, "", "opencode")
  }

  async function selectSession(session) {
    const selected = {
      id: session.id,
      backend: session.backend || "opencode",
      instanceId: session.instanceId || null,
      title: session.title,
      directory: session.directory,
      serverUrl: (session.backend || "opencode") === "opencode" ? loopbackBase(session.serverUrl) : null,
      status: session.status || "idle",
      auth: session.auth || null,
    }
    selectAgentSession(state, selected)
    saveState()
    await send(t("selected", backendText(selected.backend), selected.title, selected.id, selected.directory), { reply_markup: { inline_keyboard: [
      [{ text: t("viewDetails"), callback_data: encodeSessionAction("show", selected) }, { text: t("append"), callback_data: encodeSessionAction("addhelp", selected) }],
      [{ text: t("viewQueue"), callback_data: encodeSessionAction("queue", selected) }, { text: t("stopTask"), callback_data: encodeSessionAction("stopask", selected) }],
      [{ text: t("buttonAllSessions"), callback_data: "allsessions" }, { text: t("buttonHome"), callback_data: "home" }],
    ] } })
  }

  async function commandSessions(page = 1, query = "", backend = "all") {
    const discovered = await discoverSessions()
    const all = filterAgentSessions(discovered, backend)
    const needle = String(query || "").trim().toLowerCase()
    const filtered = needle
      ? all.filter((item) => `${item.title}\n${item.directory}`.toLowerCase().includes(needle))
      : all
    const pageSize = Math.max(4, Math.min(8, Number(config.sessionPageSize || 6)))
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
    const currentPage = Math.max(1, Math.min(Number(page) || 1, pageCount))
    const start = (currentPage - 1) * pageSize
    const sessions = filtered.slice(start, start + pageSize)
    state.sessionMap = sessions
    state.sessionBrowser = { mode: needle ? "find" : "sessions", query: String(query || "").trim(), page: currentPage, backend }
    saveState()
    if (!filtered.length) return send(needle ? t("noSearch", compact(query, 80)) : t("noSessions"), { reply_markup: { inline_keyboard: [[{ text: t("buttonHome"), callback_data: "home" }]] } })
    const numberBadges = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣"]
    const lines = sessions.map((item, index) => {
      const selectedMark = state.selected?.id === item.id && (state.selected?.backend || "opencode") === (item.backend || "opencode") ? "✅ " : ""
      return `${numberBadges[index] || `${index + 1}.`} ${selectedMark}${backendText(item.backend)} · ${item.status}\n📝「${item.title}」\n📁 ${item.directory}`
    })
    const keyboard = sessions.map((item, index) => [{
      text: `${state.selected?.id === item.id && (state.selected?.backend || "opencode") === (item.backend || "opencode") ? "✅ " : ""}${index + 1}. ${backendText(item.backend)} · ${item.title}`.slice(0, 52),
      callback_data: encodeSessionAction("select", item),
    }])
    const nav = []
    const prefix = needle ? "findpage" : "sessionspage"
    if (currentPage > 1) nav.push({ text: t("previous"), callback_data: `${prefix}:${currentPage - 1}` })
    nav.push({ text: `${currentPage}/${pageCount}`, callback_data: "noop" })
    if (currentPage < pageCount) nav.push({ text: t("next"), callback_data: `${prefix}:${currentPage + 1}` })
    keyboard.push(nav)
    keyboard.push([{ text: t("buttonOpenCode"), callback_data: "agent:opencode" }, { text: t("buttonCodex"), callback_data: "agent:codex" }, { text: t("buttonZCode"), callback_data: "agent:zcode" }, { text: t("buttonHome"), callback_data: "home" }])
    const heading = needle ? t("searchHeading", compact(query, 80)) : backend === "opencode" ? t("openCodeSessionsHeading") : backend === "codex" ? t("codexSessionsHeading") : backend === "zcode" ? t("zcodeSessionsHeading") : t("sessionsHeading")
    await send(t("page", heading, filtered.length, currentPage, pageCount, lines.join("\n\n")), { reply_markup: { inline_keyboard: keyboard } })
  }

  async function resolveActionSession(target) {
    if (!target?.id) return null
    const backend = target.backend || "opencode"
    const cached = [...(state.sessionMap || []), state.selected].filter(Boolean)
      .find((item) => item.id === target.id && (item.backend || "opencode") === backend)
    if (cached) return cached
    return (await discoverSessions()).find((item) => item.id === target.id && (item.backend || "opencode") === backend) || null
  }

  async function resolveSelected() {
    if (state.viewMode !== "agent" || !state.selected) return null
    if ((state.selected.backend || "opencode") !== state.activeBackend) return null
    if (state.activeBackend === "opencode") loopbackBase(state.selected.serverUrl)
    else if (state.activeBackend === "codex") await attachCodexAdapter()
    else if (state.activeBackend === "zcode") await attachZCodeAdapter()
    else return null
    return state.selected
  }

  async function handleCommand(command) {
    if (!command) return send(t("unknownCommand"))
    if (command.name === "help") return send(t("help"))
    if (command.name === "home") return commandHome()
    if (command.name === "opencode") return commandAgent("opencode")
    if (command.name === "codex") return commandAgent("codex")
    if (command.name === "zcode") return commandAgent("zcode")
    if (command.name === "new") {
      if (!command.arg) return send(t("newUsage"))
      const backend = state.viewMode === "agent" && state.activeBackend === "zcode" ? "zcode" : "codex"
      const projects = backend === "zcode" ? (config.zcodeProjects || config.codexProjects || {}) : (config.codexProjects || {})
      const aliases = Object.keys(projects)
      const project = resolveCodexProject(projects, command.arg.alias)
      if (!project) return send(t("projectNotFound", command.arg.alias, aliases.length ? aliases.join(", ") : t("none")))
      try {
        if (!existsSync(project.directory) || !statSync(project.directory).isDirectory()) return send(t("projectUnavailable", project.alias, project.directory))
        if (backend === "zcode") {
          const client = await attachZCodeAdapter()
          const session = await client.startSession({ cwd: project.directory, model: config.zcodeNewModel || null, thoughtLevel: config.zcodeThoughtLevel || "high", title: shortLine(command.arg.prompt, 180) })
          session.title = shortLine(command.arg.prompt, 180)
          session.status = "busy"
          session.updatedAt = Date.now()
          sessionDiscoveryCache.remember("ZCode", session)
          selectAgentSession(state, session)
          state.sessionMap = [session, ...(state.sessionMap || []).filter((item) => item.id !== session.id)].slice(0, 100)
          saveState()
          await client.sendPrompt(session.id, command.arg.prompt)
          return send(t("newStartedAgent", backendText(backend), project.alias, session.title, session.id, session.directory), { reply_markup: { inline_keyboard: [
            [{ text: t("viewDetails"), callback_data: encodeSessionAction("show", session) }, { text: t("append"), callback_data: encodeSessionAction("addhelp", session) }],
            [{ text: t("viewQueue"), callback_data: encodeSessionAction("queue", session) }, { text: t("stopTask"), callback_data: encodeSessionAction("stopask", session) }],
          ] } })
        }
        const client = await attachCodexAdapter()
        const thread = await client.startThread({ cwd: project.directory, model: config.codexNewModel || null })
        if (!thread?.id) throw new Error("Codex thread/start returned no thread id")
        const session = {
          id: String(thread.id),
          backend: "codex",
          instanceId: "codex-local",
          title: shortLine(command.arg.prompt, 180),
          directory: project.directory,
          status: "busy",
          codexStatus: { type: "active", activeFlags: [] },
          updatedAt: Date.now(),
          activeTurnId: null,
        }
        sessionDiscoveryCache.remember("Codex", session)
        selectAgentSession(state, session)
        state.sessionMap = [session, ...(state.sessionMap || []).filter((item) => item.id !== session.id)].slice(0, 100)
        saveState()
        await client.setThreadName(session.id, session.title).catch((error) => log("WARN", `unable to name new Codex thread ${session.id}: ${error.message}`))
        const turn = await client.sendPrompt(session.id, command.arg.prompt)
        session.activeTurnId = turn?.id || null
        state.selected.status = "busy"
        saveState()
        return send(t("newStartedAgent", backendText(backend), project.alias, session.title, session.id, session.directory), { reply_markup: { inline_keyboard: [
          [{ text: t("viewDetails"), callback_data: encodeSessionAction("show", session) }, { text: t("append"), callback_data: encodeSessionAction("addhelp", session) }],
          [{ text: t("viewQueue"), callback_data: encodeSessionAction("queue", session) }, { text: t("stopTask"), callback_data: encodeSessionAction("stopask", session) }],
        ] } })
      } catch (error) {
        return send(t("newFailed", compact(error.message, 300)))
      }
    }
    if (command.name === "status") {
      const codexStatus = codexClient?.ready && codexClient.isRunning
        ? `${t("online")} · ${t(String(codexClient.transport || "").startsWith("shared") ? "codexShared" : "codexPrivate")}`
        : t("offline")
      const zcodeStatus = zcodeClient?.ready && zcodeClient.isRunning ? t("online") : t("offline")
      return send(t("status", loadInstances().length, codexStatus, zcodeStatus, modeText(), state.selected ? `${backendText(state.selected.backend)} · ${state.selected.title}` : t("notSelected")))
    }
    if (command.name === "health") return send(await healthText())
    if (command.name === "approvals") {
      await refreshPermissions()
      const pending = Object.entries(state.permissionRequests).filter(([, item]) => !item.resolvedAt)
      const codexPending = Object.entries(state.codexRequests).filter(([, item]) => item.kind === "approval" && !item.resolvedAt && item.connectionId === codexClient?.connectionId)
      const zcodePending = Object.entries(state.zcodeRequests).filter(([, item]) => item.kind === "approval" && !item.resolvedAt && item.connectionId === zcodeClient?.connectionId)
      if (!pending.length && !codexPending.length && !zcodePending.length) return send(t("noApprovals"))
      for (const [token, item] of pending.slice(0, 10)) await sendPermissionRequest(token, item, true)
      for (const [token, item] of codexPending.slice(0, 10)) await sendCodexRequest(token, item, true)
      for (const [token, item] of zcodePending.slice(0, 10)) await sendZCodeRequest(token, item, true)
      return
    }
    if (command.name === "questions") {
      await refreshOpenCodeQuestions()
      const openCodePending = Object.entries(state.openCodeQuestions).filter(([, item]) => !item.resolvedAt)
      const codexPending = Object.entries(state.codexRequests).filter(([, item]) => item.kind === "question" && !item.resolvedAt && item.connectionId === codexClient?.connectionId)
      const zcodePending = Object.entries(state.zcodeRequests).filter(([, item]) => item.kind === "question" && !item.resolvedAt && item.connectionId === zcodeClient?.connectionId)
      if (!openCodePending.length && !codexPending.length && !zcodePending.length) return send(t("noQuestions"))
      for (const [token, item] of openCodePending.slice(0, 10)) await sendOpenCodeQuestion(token, item, true)
      for (const [token, item] of codexPending.slice(0, Math.max(0, 10 - openCodePending.length))) await sendCodexRequest(token, item, true)
      for (const [token, item] of zcodePending.slice(0, Math.max(0, 10 - openCodePending.length - codexPending.length))) await sendZCodeRequest(token, item, true)
      return
    }
    if (command.name === "answer") {
      await refreshOpenCodeQuestions()
      const candidates = [
        ...Object.entries(state.openCodeQuestions).filter(([, item]) => !item.resolvedAt).map(([token, request]) => ({ backend: "opencode", token, request, sessionId: request.sessionId })),
        ...Object.entries(state.codexRequests).filter(([, item]) => item.kind === "question" && !item.resolvedAt && item.connectionId === codexClient?.connectionId).map(([token, request]) => ({ backend: "codex", token, request, sessionId: request.params?.threadId })),
        ...Object.entries(state.zcodeRequests).filter(([, item]) => item.kind === "question" && !item.resolvedAt && item.connectionId === zcodeClient?.connectionId).map(([token, request]) => ({ backend: "zcode", token, request, sessionId: request.params?.sessionId })),
      ].sort((left, right) => {
        const leftTime = Date.parse(left.request.lastPresentedAt || left.request.notifiedAt || left.request.createdAt || left.request.firstSeenAt || 0)
        const rightTime = Date.parse(right.request.lastPresentedAt || right.request.notifiedAt || right.request.createdAt || right.request.firstSeenAt || 0)
        if (leftTime !== rightTime) return rightTime - leftTime
        const leftSelected = state.selected?.backend === left.backend && state.selected?.id === left.sessionId ? 1 : 0
        const rightSelected = state.selected?.backend === right.backend && state.selected?.id === right.sessionId ? 1 : 0
        return rightSelected - leftSelected
      })
      const target = candidates[0]
      if (!target) return send(t("noQuestions"))
      if (target.backend === "opencode") {
        const index = nextOpenCodeQuestionIndex(target.request)
        if (index < 0) return send(t("noQuestions"))
        completeOpenCodeQuestion(target.request, index, command.arg)
        const done = await finishOpenCodeQuestion(target.request)
        saveState()
        if (!done) await sendOpenCodeQuestion(target.token, target.request, true)
        return send(done ? t("openCodeQuestionAnswered") : t("questionAnswerSaved"))
      }
      if (target.backend === "zcode") {
        const questions = target.request.params?.questions || []
        const question = questions.find((item) => !target.request.answers?.[item.question])
        if (question) target.request.answers[question.question] = command.arg
        else target.request.answers.answer = command.arg
        const done = completeZCodeQuestionIfReady(target.request)
        saveState()
        return send(done ? t("zcodeQuestionAnswered") : t("zcodeAnswerSaved"))
      }
      const question = (target.request.params?.questions || []).find((item) => !target.request.answers?.[item.id])
      if (!question) return send(t("noQuestions"))
      target.request.answers[question.id] = { answers: [command.arg] }
      const done = completeCodexQuestionIfReady(target.request)
      saveState()
      return send(done ? t("codexQuestionAnswered") : t("codexAnswerSaved"))
    }
    if (command.name === "sessions") {
      enterGlobalMode(state)
      saveState()
      return commandSessions(command.arg || 1, "", "all")
    }
    if (command.name === "find") {
      return commandSessions(1, command.arg, state.viewMode === "agent" ? state.activeBackend : "all")
    }
    if (command.name === "use") {
      let session = null
      const index = Number.parseInt(command.arg, 10)
      if (Number.isInteger(index) && index > 0) session = state.sessionMap?.[index - 1] || null
      if (!session) {
        const sessions = await discoverSessions()
        const matches = sessions.filter((item) => item.id === command.arg || item.id.startsWith(command.arg))
        if (matches.length === 1) session = matches[0]
      }
      return session ? selectSession(session) : send(t("sessionNotFound"))
    }
    if (command.name === "current") {
      if (state.viewMode !== "agent") return commandHome()
      const selected = await resolveSelected()
      return selected ? send(t("selected", backendText(selected.backend), selected.title, selected.id, selected.directory)) : send(t("selectFirst"))
    }
    const selected = await resolveSelected()
    if (!selected) return send(t("selectFirst"))
    if (command.name === "show") return send(await getSessionView(selected))
    if (command.name === "queue") return send(queueSummary(selected))
    if (command.name === "steer") {
      if ((selected.backend || "opencode") !== "codex") return send(t("steerCodexOnly"))
      try {
        const client = await ensureCodexClient(config.codexCommand || null)
        await client.steer(selected.id, command.arg)
        return send(t("steered"))
      } catch (error) {
        return send(t("steerFailed", compact(error.message, 300)))
      }
    }
    if (command.name === "add") {
      const key = migrateSessionState(selected)
      const queue = waitingQueue(selected)
      const limit = Number(config.queueLimit || 20)
      const occupied = queue.length + (state.queueInFlight[key] ? 1 : 0)
      if (occupied >= limit) return send(t("queueFull", limit))
      const [item] = makeQueueItems([command.arg])
      queue.push(item)
      saveState()
      const status = await currentSessionStatus(selected)
      if (status === "idle" && !state.queuePaused[key] && !state.queueInFlight[key]) {
        try {
          const started = await dispatchNext(selected)
          if (started) return send(t("addStarted", compact(started.item.text, 500), started.remaining))
        } catch (error) {
          return send(t("savedStartFailed", compact(error.message, 300)))
        }
      }
      state.queueStartOnIdle[key] = status !== "idle"
      saveState()
      return send(t("added", status, queue.length))
    }
    if (command.name === "batch") {
      const key = migrateSessionState(selected)
      const queue = waitingQueue(selected)
      const limit = Number(config.queueLimit || 20)
      let parts
      try { parts = parseBatch(command.arg, limit) } catch (error) { return send(error.message) }
      const occupied = queue.length + (state.queueInFlight[key] ? 1 : 0)
      if (occupied + parts.length > limit) return send(t("batchCapacity", limit, Math.max(0, limit - occupied)))
      queue.push(...makeQueueItems(parts))
      saveState()
      const status = await currentSessionStatus(selected)
      if (status === "idle" && !state.queuePaused[key] && !state.queueInFlight[key]) {
        try {
          const started = await dispatchNext(selected)
          if (started) return send(t("batchStarted", parts.length, compact(started.item.text, 500), started.remaining))
        } catch (error) {
          return send(t("batchSavedFailed", parts.length, compact(error.message, 300)))
        }
      }
      state.queueStartOnIdle[key] = status !== "idle"
      saveState()
      return send(t("batchAdded", parts.length, status, queue.length))
    }
    if (command.name === "remove") {
      const queue = waitingQueue(selected)
      const index = command.arg - 1
      if (index < 0 || index >= queue.length) return send(t("badQueueIndex"))
      const [removed] = queue.splice(index, 1)
      saveState()
      return send(t("removed", compact(removed.text, 500)))
    }
    if (command.name === "pause") {
      state.queuePaused[migrateSessionState(selected)] = true
      saveState()
      return send(t("paused"))
    }
    if (command.name === "resume") {
      const key = migrateSessionState(selected)
      state.queuePaused[key] = false
      saveState()
      const status = await currentSessionStatus(selected)
      if (status === "idle" && !state.queueInFlight[key]) {
        try {
          const started = await dispatchNext(selected)
          if (started) return send(t("resumedStarted", compact(started.item.text, 500), started.remaining))
        } catch (error) {
          return send(t("resumedFailed", compact(error.message, 300)))
        }
      }
      state.queueStartOnIdle[key] = status !== "idle" && waitingQueue(selected).length > 0
      saveState()
      return send(t("resumed", status))
    }
    if (command.name === "clearqueue") {
      const count = waitingQueue(selected).length
      if (!count) return send(t("queueEmpty"))
      return send(t("confirmClear", count), { reply_markup: { inline_keyboard: [[{ text: t("confirmClearButton"), callback_data: encodeSessionAction("clearq", selected) }, { text: t("cancel"), callback_data: "cancel" }]] } })
    }
    if (command.name === "send") {
      if ((selected.backend || "opencode") === "codex") {
        const key = migrateSessionState(selected)
        const client = await ensureCodexClient(config.codexCommand || null)
        const knownBusy = state.queueInFlight[key] || client.activeTurns.has(String(selected.id))
        if (knownBusy) return queueVisibleCodexTurn(selected, command.arg, "busy")
        try {
          await client.sendPrompt(selected.id, command.arg)
          selected.status = "busy"
          selected.updatedAt = Date.now()
          sessionDiscoveryCache.remember("Codex", selected)
          saveState()
        } catch (error) {
          if (error?.code === "CODEX_TURN_ACTIVE" || /already has an active (?:turn|writer)/i.test(String(error?.message || error))) {
            return queueVisibleCodexTurn(selected, command.arg, "busy")
          }
          throw error
        }
      } else if (selected.backend === "zcode") {
        const client = await ensureZCodeClient(config.zcodeBundle || null)
        await client.sendPrompt(selected.id, command.arg)
        selected.status = "busy"
        selected.updatedAt = Date.now()
        sessionDiscoveryCache.remember("ZCode", selected)
      } else {
        const id = encodeURIComponent(selected.id)
        await requestSessionJson(selected, `/session/${id}/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: command.arg }] }),
        })
      }
      return send(t("sentAgent", backendText(selected.backend)))
    }
    if (command.name === "stop") {
      return send(t("confirmStop", selected.title), { reply_markup: { inline_keyboard: [[{ text: t("confirmStopButton"), callback_data: encodeSessionAction("abort", selected) }, { text: t("cancel"), callback_data: "cancel" }]] } })
    }
  }

  async function handleCallback(query) {
    if (!authorizedCallback(query)) {
      log("AUDIT", `ignored unauthorized callback user=${query?.from?.id || "unknown"}`)
      return
    }
    noteForegroundActivity()
    const data = String(query.data || "")
    let callbackAnswered = false
    log("AUDIT", `callback user=${query.from.id} data=${data}`)
    try {
      const permissionMatch = data.match(/^perm:([0-9a-f]{16}):(once|always|reject)$/)
      if (permissionMatch) {
        const [, token, reply] = permissionMatch
        const request = state.permissionRequests[token]
        if (!request || request.resolvedAt) throw new Error(t("alreadyHandled"))
        await replyToPermission(request, reply)
        request.resolvedAt = new Date().toISOString()
        request.resolution = reply
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("handled", permissionActionText(reply)) })
        if (query.message?.message_id) {
          const text = `${permissionDetails(request)}\n\n${reply === "reject" ? "⛔" : "✅"} ${t("handled", permissionActionText(reply))}`
          await telegram("editMessageText", {
            chat_id: String(config.allowedChatId),
            message_id: query.message.message_id,
            ...telegramMarkdownBody(compact(text, 3900), { reply_markup: { inline_keyboard: [] } }),
          }).catch((error) => log("WARN", `unable to update permission message: ${error.message}`))
        }
      }
      else if (/^oqa:[0-9a-f]{16}:\d+:\d+$/.test(data)) {
        const [, token, questionText, optionText] = data.split(":")
        const request = activeOpenCodeQuestion(token)
        const questionIndex = Number(questionText)
        const option = request.questions?.[questionIndex]?.options?.[Number(optionText)]
        if (!option || questionIndex !== nextOpenCodeQuestionIndex(request)) throw new Error(t("questionExpired"))
        const completed = chooseOpenCodeQuestionOption(request, questionIndex, option.label)
        const done = completed ? await finishOpenCodeQuestion(request) : false
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: done ? t("openCodeQuestionAnswered") : completed ? t("questionAnswerSaved") : t("choiceUpdated") })
        if (query.message?.message_id) {
          if (done) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
          else await telegram("editMessageText", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, ...telegramMarkdownBody(openCodeQuestionText(request), { reply_markup: openCodeQuestionKeyboard(token, request) }) }).catch((error) => log("WARN", `unable to update question message: ${error.message}`))
        }
      }
      else if (/^oqs:[0-9a-f]{16}:\d+$/.test(data)) {
        const [, token, questionText] = data.split(":")
        const request = activeOpenCodeQuestion(token)
        const questionIndex = Number(questionText)
        if (questionIndex !== nextOpenCodeQuestionIndex(request) || !request.questions?.[questionIndex]?.multiple) throw new Error(t("questionExpired"))
        completeOpenCodeQuestion(request, questionIndex)
        const done = await finishOpenCodeQuestion(request)
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: done ? t("openCodeQuestionAnswered") : t("questionAnswerSaved") })
        if (query.message?.message_id) {
          if (done) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
          else await telegram("editMessageText", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, ...telegramMarkdownBody(openCodeQuestionText(request), { reply_markup: openCodeQuestionKeyboard(token, request) }) }).catch((error) => log("WARN", `unable to update question message: ${error.message}`))
        }
      }
      else if (/^oqr:[0-9a-f]{16}$/.test(data)) {
        const [, token] = data.split(":")
        const request = activeOpenCodeQuestion(token)
        await postOpenCodeQuestion(request, "reject")
        request.resolvedAt = new Date().toISOString()
        request.resolution = "rejected"
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("questionRejected") })
        if (query.message?.message_id) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      }
      else if (/^cap:[0-9a-f]{16}:[A-Za-z]+$/.test(data)) {
        const [, token, action] = data.split(":")
        const request = activeCodexRequest(token)
        if (request.kind !== "approval") throw new Error(t("alreadyHandled"))
        const result = approvalResponseForRequest(request.method, request.params, action)
        codexClient.respond(request.requestId, result)
        request.resolvedAt = new Date().toISOString()
        request.resolution = action
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("codexApprovalHandled") })
        if (query.message?.message_id) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      }
      else if (/^cqa:[0-9a-f]{16}:\d+:\d+$/.test(data)) {
        const [, token, questionText, optionText] = data.split(":")
        const request = activeCodexRequest(token)
        if (request.kind !== "question") throw new Error(t("alreadyHandled"))
        const question = request.params?.questions?.[Number(questionText)]
        const option = question?.options?.[Number(optionText)]
        if (!question || !option) throw new Error(t("approvalExpired"))
        request.answers[question.id] = { answers: [option.label] }
        const done = completeCodexQuestionIfReady(request)
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: done ? t("codexQuestionAnswered") : t("codexAnswerSaved") })
        if (done && query.message?.message_id) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      }
      else if (/^zap:[0-9a-f]{16}:\d+$/.test(data)) {
        const [, token, optionText] = data.split(":")
        const request = activeZCodeRequest(token)
        if (request.kind !== "approval") throw new Error(t("alreadyHandled"))
        const option = request.params?.options?.[Number(optionText)]
        if (!option?.response) throw new Error(t("approvalExpired"))
        zcodeClient.respond(request.requestId, option.response)
        request.resolvedAt = new Date().toISOString()
        request.resolution = option.optionId || option.kind || String(optionText)
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("zcodeApprovalHandled") })
        if (query.message?.message_id) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      }
      else if (/^zqa:[0-9a-f]{16}:\d+:\d+$/.test(data)) {
        const [, token, questionText, optionText] = data.split(":")
        const request = activeZCodeRequest(token)
        if (request.kind !== "question") throw new Error(t("alreadyHandled"))
        const question = request.params?.questions?.[Number(questionText)]
        const option = question?.options?.[Number(optionText)]
        if (!question || !option) throw new Error(t("questionExpired"))
        request.answers[question.question] = option.value || option.label
        const done = completeZCodeQuestionIfReady(request)
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: done ? t("zcodeQuestionAnswered") : t("zcodeAnswerSaved") })
        if (done && query.message?.message_id) await telegram("editMessageReplyMarkup", { chat_id: String(config.allowedChatId), message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
      }
      else if (data === "noop") await telegram("answerCallbackQuery", { callback_query_id: query.id })
      else if (data === "cancel") await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("cancelled") })
      else if (data === "home") {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        await commandHome()
      } else if (data === "allsessions") {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        enterGlobalMode(state)
        saveState()
        await commandSessions(1, "", "all")
      } else if (data.startsWith("agent:")) {
        const backend = data.slice(6)
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: backendText(backend) })
        await commandAgent(backend)
      }
      else if (data.startsWith("sessionspage:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        await commandSessions(Number.parseInt(data.slice(13), 10) || 1, "", state.sessionBrowser?.backend || "all")
      } else if (data.startsWith("findpage:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        await commandSessions(Number.parseInt(data.slice(9), 10) || 1, state.sessionBrowser?.query || "", state.sessionBrowser?.backend || "all")
      }
      else if (data.startsWith("select:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        callbackAnswered = true
        const target = decodeSessionAction(data, "select")
        const session = await resolveActionSession(target)
        if (!session) throw new Error(t("sessionUnavailable"))
        await selectSession(session)
      } else if (data.startsWith("show:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        callbackAnswered = true
        const target = decodeSessionAction(data, "show")
        const session = await resolveActionSession(target)
        if (!session) throw new Error(t("sessionUnavailable"))
        await send(await getSessionView(session))
      } else if (data.startsWith("addhelp:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        callbackAnswered = true
        const target = decodeSessionAction(data, "addhelp")
        const session = await resolveActionSession(target)
        if (!session) throw new Error(t("sessionUnavailable"))
        selectAgentSession(state, { id: session.id, backend: session.backend || "opencode", instanceId: session.instanceId || null, title: session.title, directory: session.directory, serverUrl: (session.backend || "opencode") === "opencode" ? loopbackBase(session.serverUrl) : null, status: session.status || "idle", auth: session.auth || null })
        saveState()
        await send(t("addHelp", session.title))
      } else if (data.startsWith("queue:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        callbackAnswered = true
        const target = decodeSessionAction(data, "queue")
        const session = await resolveActionSession(target)
        if (!session) throw new Error(t("sessionUnavailable"))
        await send(queueSummary(session))
      } else if (data.startsWith("stopask:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        callbackAnswered = true
        const target = decodeSessionAction(data, "stopask")
        const session = await resolveActionSession(target)
        if (!session) throw new Error(t("sessionUnavailable"))
        await send(t("confirmStop", session.title), { reply_markup: { inline_keyboard: [[{ text: t("confirmStopButton"), callback_data: encodeSessionAction("abort", session) }, { text: t("cancel"), callback_data: "cancel" }]] } })
      } else if (data.startsWith("abort:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        callbackAnswered = true
        const target = decodeSessionAction(data, "abort")
        const selected = await resolveActionSession(target)
        if (!selected) throw new Error(t("sessionUnavailable"))
        const key = migrateSessionState(selected)
        state.queuePaused[key] = true
        state.queueStartOnIdle[key] = false
        saveState()
        if ((selected.backend || "opencode") === "codex") {
          const client = await ensureCodexClient(config.codexCommand || null)
          await client.interrupt(selected.id)
        } else if (selected.backend === "zcode") {
          const client = await ensureZCodeClient(config.zcodeBundle || null)
          await client.interrupt(selected.id)
        } else {
          await requestSessionJson(selected, `/session/${encodeURIComponent(selected.id)}/abort`, { method: "POST" })
        }
        await send(t("stopDoneAgent", backendText(selected.backend)))
      } else if (data.startsWith("clearq:")) {
        const target = decodeSessionAction(data, "clearq")
        const selected = await resolveSelected()
        if (!selected || selected.id !== target?.id || (selected.backend || "opencode") !== target?.backend) throw new Error(t("currentChanged"))
        state.queues[migrateSessionState(selected)] = []
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("queueCleared") })
        await send(t("queueClearedDetail"))
      }
    } catch (error) {
      if (callbackAnswered) await send(t("operationFailed", compact(error.message, 500))).catch(() => {})
      else await telegram("answerCallbackQuery", { callback_query_id: query.id, text: compact(error.message, 120), show_alert: true }).catch(() => {})
    }
  }

  async function processUpdate(update) {
    if (update.callback_query) return handleCallback(update.callback_query)
    const message = update.message
    if (!authorizedMessage(message) || typeof message.text !== "string") {
      if (message) log("AUDIT", `rejected Telegram message user=${message.from?.id} chat=${message.chat?.id} type=${message.chat?.type}`)
      return
    }
    noteForegroundActivity()
    log("AUDIT", `command user=${message.from.id} text=${message.text.slice(0, 80)}`)
    await handleCommand(parseCommand(message.text))
  }

  async function telegramLoop() {
    while (true) {
      try {
        if (!telegramReady) await configureTelegram(false)
        const updates = await telegram("getUpdates", { offset: Number(state.updateOffset || 0), timeout: 30, allowed_updates: ["message", "callback_query"] })
        if (telegramFailureCount > 0) log("INFO", `Telegram connection restored after ${telegramFailureCount} failure(s)`)
        telegramFailureCount = 0
        if (clearRecoveredError(state, "telegram-polling", "telegram-startup")) saveState()
        for (const update of updates || []) {
          try { await processUpdate(update) } catch (error) { recordError("telegram-command", error); log("ERROR", `Telegram update failed: ${error.stack || error.message}`); await send(t("operationFailed", compact(error.message, 500))).catch(() => {}) }
          state.updateOffset = Number(update.update_id) + 1
          saveState()
        }
      } catch (error) {
        telegramReady = false
        telegramFailureCount += 1
        recordError("telegram-polling", error)
        if (telegramFailureCount === 1 || telegramFailureCount % 10 === 0) log("WARN", `Telegram polling failed (${telegramFailureCount} consecutive): ${error.message}`)
        await sleep(Math.min(60000, 5000 * (2 ** Math.min(telegramFailureCount - 1, 4))))
      }
    }
  }

  function completionButtons(event) {
    if (!event.sessionId) return {}
    const backend = event.backend || "opencode"
    const current = state.selected?.id === event.sessionId && (state.selected?.backend || "opencode") === backend
    return { reply_markup: { inline_keyboard: [
      [{ text: current ? t("currentSession") : t("enterSession"), callback_data: encodeSessionAction("select", event) }, { text: t("viewDetails"), callback_data: encodeSessionAction("show", event) }],
      [{ text: t("append"), callback_data: encodeSessionAction("addhelp", event) }, { text: t("viewQueue"), callback_data: encodeSessionAction("queue", event) }],
      [{ text: t("stopTask"), callback_data: encodeSessionAction("stopask", event) }, { text: t("buttonHome"), callback_data: "home" }],
    ] } }
  }

  function pendingCompletionExists(session, dispatchedAt) {
    const expectedKey = sessionStateKey(session)
    return readdirSync(eventsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .some((entry) => {
        const event = readJson(join(eventsDir, entry.name))
        return event?.sessionId && sessionStateKey(event) === expectedKey && Date.parse(event.createdAt || 0) >= Date.parse(dispatchedAt || 0)
      })
  }

  async function recentSessionMessages(session, limit = 30) {
    return requestJson(sessionUrl(session, `/session/${encodeURIComponent(session.id)}/message`) + `&limit=${limit}`, { headers: openCodeHeaders(session) })
  }

  function messageTimestamp(message) { return openCodeTimestamp(message) }

  function messageText(message) { return openCodeText(message) }

  async function synthesizeRecoveredCompletion(session, item) {
    if ((session.backend || "opencode") === "codex") {
      const client = await ensureCodexClient(config.codexCommand || null)
      const thread = await client.readThread(session.id)
      const sentAtSeconds = Math.floor(Date.parse(item.dispatchedAt || item.createdAt || 0) / 1000)
      const turns = Array.isArray(thread?.turns) ? thread.turns : []
      const turn = (item.turnId ? turns.find((candidate) => candidate.id === item.turnId) : null)
        || [...turns].reverse().find((candidate) => Number(candidate.startedAt || 0) >= sentAtSeconds - 5)
      if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return false
      const payload = terminalEventFromNotification({ threadId: session.id, turn }, thread)
      payload.recovered = true
      atomicJson(join(eventsDir, `${Date.now()}-${randomUUID()}.json`), payload)
      return true
    }
    if (session.backend === "zcode") {
      const client = await ensureZCodeClient(config.zcodeBundle || null)
      const result = await client.request("session/events", { sessionId: session.id, limit: 200 })
      const sentAt = Date.parse(item.dispatchedAt || item.createdAt || 0)
      const event = [...(result?.events || [])].reverse().find((candidate) => ["turn.completed", "turn.failed"].includes(candidate?.type) && timestampMilliseconds(candidate?.timestamp) >= sentAt - 5000)
      if (!event) return false
      const payload = zcodeTerminalEvent(event, { sessionId: session.id, title: session.title, workspace: { workspacePath: session.directory } })
      payload.recovered = true
      atomicJson(join(eventsDir, `${Date.now()}-${randomUUID()}.json`), payload)
      return true
    }
    const messages = await recentSessionMessages(session)
    const sentAt = Date.parse(item.dispatchedAt || item.createdAt || 0)
    const prompt = messages.filter((message) => message?.info?.role === "user"
      && messageTimestamp(message) >= sentAt - 5000
      && messageText(message) === String(item.text || "").trim())
      .sort((a, b) => messageTimestamp(b) - messageTimestamp(a))[0]
    if (!prompt) return false
    const promptAt = messageTimestamp(prompt)
    const assistant = messages.filter((message) => message?.info?.role === "assistant" && messageTimestamp(message) >= promptAt)
      .sort((a, b) => messageTimestamp(b) - messageTimestamp(a))[0]
    const assistantError = assistant?.info?.error || null
    const recoveryError = assistantError
      ? String(assistantError?.data?.message || assistantError?.message || assistantError?.name || "OpenCode task failed")
      : !assistant ? "OpenCode task ended without an assistant reply" : null
    const payload = {
      version: 1,
      id: `recovered-${randomUUID()}`,
      type: recoveryError ? "session.error" : "session.idle",
      turnId: String(prompt?.info?.id || ""),
      backend: session.backend || "opencode",
      createdAt: new Date().toISOString(),
      sessionId: session.id,
      title: session.title,
      directory: session.directory,
      serverUrl: session.serverUrl,
      summary: session.summary || null,
      excerpt: assistant ? messageText(assistant).slice(0, 1800) : "",
      error: recoveryError,
      recovered: true,
    }
    atomicJson(join(eventsDir, `${Date.now()}-${payload.id}.json`), payload)
    return true
  }

  async function reconcileQueues() {
    const activeEntries = Object.entries(state.queueInFlight)
    if (!activeEntries.length) return
    const sessions = await discoverSessions()
    const byKey = new Map(sessions.map((session) => [sessionStateKey(session), session]))
    const byLegacyId = new Map(sessions.map((session) => [session.id, session]))
    for (const [storedKey, originalItem] of activeEntries) {
      const session = byKey.get(storedKey) || byLegacyId.get(storedKey)
      if (!session) continue
      const key = migrateSessionState(session)
      const item = state.queueInFlight[key] || originalItem
      const status = await currentSessionStatus(session)
      if (status !== "idle") continue
      if (pendingCompletionExists(session, item.dispatchedAt)) continue
      try {
        if (await synthesizeRecoveredCompletion(session, item)) {
          log("INFO", `recovered completed queue item session=${session.id} item=${item.id}`)
          continue
        }
        waitingQueue(session).unshift(item)
        delete state.queueInFlight[key]
        saveState()
        if (!state.queuePaused[key]) await dispatchNext(session)
      } catch (error) {
        recordError("queue-recovery", error)
        log("WARN", `queue recovery failed session=${session.id}: ${error.message}`)
      }
    }
  }

  async function recoveryLoop() {
    await sleep(10000)
    while (true) {
      try { await reconcileQueues() } catch (error) { recordError("queue-recovery", error) }
      await sleep(60000)
    }
  }

  async function permissionLoop() {
    while (true) {
      try { await refreshPermissions() } catch (error) {
        recordError("permission-monitor", error)
        log("WARN", `permission monitor failed: ${error.message}`)
      }
      try { await refreshOpenCodeQuestions() } catch (error) {
        recordError("question-monitor", error)
        log("WARN", `question monitor failed: ${error.message}`)
      }
      try { await refreshCodexRequests() } catch (error) {
        recordError("codex-request-monitor", error)
        log("WARN", `Codex request monitor failed: ${error.message}`)
      }
      try { await refreshZCodeRequests() } catch (error) {
        recordError("zcode-request-monitor", error)
        log("WARN", `ZCode request monitor failed: ${error.message}`)
      }
      await sleep(5000)
    }
  }

  async function codexLoop() {
    while (true) {
      if (!codexClient?.ready || !codexClient.isRunning || !codexClient.agentTaskHubAttached) {
        try {
          await attachCodexAdapter()
          log("INFO", "Codex app-server adapter connected")
        } catch (error) {
          recordError("codex-reconnect", error)
        }
      }
      await sleep(15000)
    }
  }

  async function zcodeLoop() {
    while (true) {
      if (!zcodeClient?.ready || !zcodeClient.isRunning || !zcodeClient.agentTaskHubAttached) {
        try {
          await attachZCodeAdapter()
          log("INFO", "ZCode app-server adapter connected")
        } catch (error) {
          recordError("zcode-reconnect", error)
        }
      }
      await sleep(15000)
    }
  }

  async function eventLoop() {
    while (true) {
      const files = readdirSync(eventsDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort().slice(0, 20)
      for (const name of files) {
        const path = join(eventsDir, name)
        const event = readJson(path)
        if (!event) { rmSync(path, { force: true }); continue }
        if (event.nextAttemptAt && Date.parse(event.nextAttemptAt) > Date.now()) continue
        if (event.backend === "opencode" && event.type === "session.idle" && Date.now() - Date.parse(event.createdAt || 0) < 2500) continue
        if (Date.now() - Date.parse(event.createdAt || 0) > 7 * 86400000) { rmSync(path, { force: true }); continue }
        const eventKey = event.sessionId ? migrateSessionState(event) : null
        const activeQueueItem = eventKey ? state.queueInFlight[eventKey] : null
        const matchesQueue = Boolean(activeQueueItem && Date.parse(event.createdAt || 0) >= Date.parse(activeQueueItem.dispatchedAt || 0))
        if (eventAlreadyHandled(event, matchesQueue ? activeQueueItem : null)) {
          rmSync(path, { force: true })
          log("INFO", `duplicate completion ignored event=${event.id || name} session=${event.sessionId || "none"}`)
          continue
        }
        const waiting = event.sessionId ? waitingQueue(event).length : 0
        const isInterrupted = event.type === "session.interrupted" || event.status === "interrupted"
        const isError = event.type === "session.error"
        const unsuccessful = isError || isInterrupted
        let queueNote = t("manualSource")
        if (matchesQueue) {
          const progress = activeQueueItem.batchTotal > 1 ? t("itemProgress", activeQueueItem.batchIndex, activeQueueItem.batchTotal) : t("queueItem")
          const next = waitingQueue(event)[0]
          queueNote = t("queueProgress", progress, isInterrupted ? t("interrupted") : isError ? t("executionFailed") : t("completed"), durationText(activeQueueItem.dispatchedAt, Date.parse(event.createdAt || Date.now())), waiting, next ? t("nextTask", compact(next.text, 180)) : "")
          if (unsuccessful) queueNote += t("queueAutoPaused")
        } else if (eventKey && state.queueStartOnIdle[eventKey] && waiting) {
          queueNote += t("waitingWillStart", waiting)
        }
        const icon = isInterrupted ? "⏹" : isError ? "❌" : "✅"
        const stats = event.summary ? t("changeStats", event.summary.files || 0, event.summary.additions || 0, event.summary.deletions || 0) : ""
        const detail = isError ? t("error", event.error || t("unknownError")) : event.excerpt ? t("latestReply", event.excerpt) : ""
        const text = compact(t("completionAgent", icon, backendText(event.backend || "opencode"), isInterrupted ? t("taskInterrupted") : isError ? t("executionFailed") : t("taskCompleted"), event.title, event.directory, stats, queueNote, detail))
        try {
          await send(text, completionButtons(event))
          if (matchesQueue) {
            delete state.queueInFlight[eventKey]
            if (unsuccessful) {
              state.queuePaused[eventKey] = true
              state.queueStartOnIdle[eventKey] = false
            }
          }
          rememberEvent(event)
          rmSync(path, { force: true })
          const shouldStart = eventKey && event.type === "session.idle" && waiting && !state.queuePaused[eventKey]
            && (matchesQueue || state.queueStartOnIdle[eventKey])
          if (shouldStart) {
            state.queueStartOnIdle[eventKey] = false
            saveState()
            try {
              await dispatchNext({ id: event.sessionId, backend: event.backend || "opencode", instanceId: event.instanceId || null, title: event.title, directory: event.directory, serverUrl: event.serverUrl })
            } catch (error) {
              recordError("queue-dispatch", error)
              await send(t("nextFailed", compact(error.message, 300))).catch(() => {})
            }
          } else if (matchesQueue && !unsuccessful && waiting === 0) {
            await send(t("allDone", event.title))
          }
        } catch (error) {
          event.attempts = Number(event.attempts || 0) + 1
          event.nextAttemptAt = new Date(Date.now() + Math.min(300000, 5000 * (2 ** Math.min(event.attempts, 6)))).toISOString()
          atomicJson(path, event)
          recordError("notification", error)
          log("WARN", `notification failed ${name}: ${error.message}`)
        }
      }
      await sleep(1500)
    }
  }

  async function configureTelegram(announce) {
    const me = await telegram("getMe")
    await telegram("setMyCommands", { commands: botCommands })
    telegramReady = true
    log("INFO", `bridge connected bot=@${me.username}`)
    if (announce) await send(t("onlineAnnouncement"))
  }

  if (options.homeCheck) {
    try { await attachCodexAdapter() } catch {}
    try { await attachZCodeAdapter() } catch {}
    const renderStartedAt = Date.now()
    const payload = await buildHomePayload()
    const renderMs = Date.now() - renderStartedAt
    const callbacks = payload.reply_markup.inline_keyboard.flat().map((button) => String(button.callback_data || ""))
    if (!payload.text.includes(t("agentOpenCode")) || !payload.text.includes(t("agentCodex")) || !payload.text.includes(t("agentZCode"))) throw new Error("Dashboard agent sections are incomplete")
    if (payload.text.length > 3900) throw new Error("Dashboard text exceeds Telegram limit")
    if (callbacks.some((value) => Buffer.byteLength(value, "utf8") > 64)) throw new Error("Dashboard callback exceeds Telegram limit")
    const warmStartedAt = Date.now()
    await buildHomePayload()
    const warmMs = Date.now() - warmStartedAt
    console.log(`HOME_CHECK=PASS SESSIONS=${payload.sessions.length} RUNNING=${payload.running.length} TEXT=${payload.text.length} BUTTONS=${callbacks.length} RENDER_MS=${renderMs} WARM_MS=${warmMs}`)
    await codexClient?.stop().catch(() => {})
    await zcodeClient?.stop().catch(() => {})
    return
  }

  try {
    await attachCodexAdapter()
    log("INFO", "Codex app-server adapter connected")
  } catch (error) {
    recordError("codex-startup", error)
    log("WARN", `Codex adapter startup failed; OpenCode remains available: ${error.message}`)
  }
  try {
    await attachZCodeAdapter()
    log("INFO", "ZCode app-server adapter connected")
  } catch (error) {
    recordError("zcode-startup", error)
    log("WARN", `ZCode adapter startup failed; other agents remain available: ${error.message}`)
  }
  void (async () => {
    await discoverSessions({ force: true })
    await sessionDiscoveryCache.whenIdle(["OpenCode", "Codex", "ZCode"])
    const sessions = await discoverSessions()
    log("INFO", `session cache prewarmed sessions=${sessions.length}`)
  })().catch((error) => log("WARN", `session cache prewarm failed: ${error.message}`))
  try {
    await configureTelegram(true)
  } catch (error) {
    recordError("telegram-startup", error)
    log("WARN", `Telegram startup connection failed; retrying without exiting: ${error.message}`)
  }
  await Promise.all([telegramLoop(), eventLoop(), recoveryLoop(), permissionLoop(), codexLoop(), zcodeLoop(), openCodeMonitorLoop()])
}

async function check() {
  ensureDirectories()
  const config = readJson(configPath)
  if (!config) throw new Error("NOT_CONFIGURED")
  const token = decryptToken()
  const result = await requestJson(`https://api.telegram.org/bot${token}/getMe`)
  if (!result?.ok) throw new Error("Telegram getMe failed")
  const commandResult = await requestJson(`https://api.telegram.org/bot${token}/getMyCommands`)
  const commandNames = new Set((commandResult?.result || []).map((item) => item.command))
  if (!["home", "sessions", "opencode", "codex", "zcode", "add", "batch"].every((name) => commandNames.has(name))) throw new Error("Telegram command menu is incomplete")
  const sessions = await discoverSessions()
  const codexSessions = filterAgentSessions(sessions, "codex").length
  const zcodeSessions = filterAgentSessions(sessions, "zcode").length
  console.log(`CHECK=PASS BOT=@${result.result.username} INSTANCES=${loadInstances().length} SESSIONS=${sessions.length} CODEX_SESSIONS=${codexSessions} ZCODE_SESSIONS=${zcodeSessions} COMMANDS=home,sessions,opencode,codex,zcode,add,batch`)
  await codexClient?.stop().catch(() => {})
  await zcodeClient?.stop().catch(() => {})
}

function selfTest() {
  if (parseCommand("/start").name !== "home") throw new Error("parse start failed")
  if (parseCommand("/home").name !== "home") throw new Error("parse home failed")
  if (parseCommand("/opencode").name !== "opencode") throw new Error("parse opencode failed")
  if (parseCommand("/codex").name !== "codex") throw new Error("parse codex failed")
  if (parseCommand("/zcode").name !== "zcode") throw new Error("parse zcode failed")
  if (parseCommand("/new hub | 检查项目").arg?.alias !== "hub" || parseCommand("/new hub | 检查项目").arg?.prompt !== "检查项目") throw new Error("parse new failed")
  if (parseCommand("/new bad")?.name !== "new" || parseCommand("/new bad")?.arg !== null) throw new Error("parse invalid new failed")
  if (parseCommand("/sessions").name !== "sessions") throw new Error("parse sessions failed")
  if (parseCommand("/sessions 2").arg !== 2) throw new Error("parse sessions page failed")
  if (parseCommand("/find paper project").arg !== "paper project") throw new Error("parse find failed")
  if (parseCommand("/health").name !== "health") throw new Error("parse health failed")
  if (parseCommand("/approvals").name !== "approvals") throw new Error("parse approvals failed")
  if (parseCommand("/questions").name !== "questions") throw new Error("parse questions failed")
  if (parseCommand("/answer continue").arg !== "continue") throw new Error("parse answer failed")
  if (parseCommand("/send 继续运行测试").arg !== "继续运行测试") throw new Error("parse send failed")
  if (parseCommand("/steer 优先修复失败测试").arg !== "优先修复失败测试") throw new Error("parse steer failed")
  if (parseCommand("/add 先运行测试").name !== "add") throw new Error("parse add failed")
  if (parseCommand("/batch 先运行测试\n---\n再写文档").name !== "batch") throw new Error("parse batch failed")
  if (parseBatch("先运行测试\n---\n再写文档").length !== 2) throw new Error("split batch failed")
  if (eventFingerprint({ type: "session.idle", sessionId: "s", excerpt: "ok" }) !== eventFingerprint({ id: "other", type: "session.idle", sessionId: "s", excerpt: "ok" })) throw new Error("event fingerprint unstable")
  if (eventFingerprint({ type: "session.idle", sessionId: "s", excerpt: "ok" }) === eventFingerprint({ type: "session.idle", sessionId: "s", excerpt: "different" })) throw new Error("event fingerprint collision")
  const recoveredState = { lastError: { scope: "telegram-polling", message: "temporary" } }
  if (!clearRecoveredError(recoveredState, "telegram-polling") || recoveredState.lastError !== null) throw new Error("recovered error was not cleared")
  const unrelatedState = { lastError: { scope: "notification", message: "keep" } }
  if (clearRecoveredError(unrelatedState, "telegram-polling") || unrelatedState.lastError?.scope !== "notification") throw new Error("unrelated error was cleared")
  const polled = openCodeTerminalEvent({ id: "s", title: "Test", directory: "C:\\work", serverUrl: "http://127.0.0.1:4096", updated: 1700000000000 }, [
    { info: { id: "m", role: "assistant", time: { completed: 1700000000000 } }, parts: [{ type: "text", text: "done" }] },
  ])
  if (polled.type !== "session.idle" || polled.excerpt !== "done" || !polled.id.startsWith("opencode-poll:")) throw new Error("OpenCode terminal polling event failed")
  if (openCodeTerminalEvent({ id: "s" }, [
    { info: { id: "old", role: "assistant", time: { completed: 100 } }, parts: [{ type: "text", text: "previous task" }] },
    { info: { id: "current", role: "user", time: { created: 200 } }, parts: [{ type: "text", text: "stop" }] },
  ]) !== null) throw new Error("aborted OpenCode turn must not reuse a previous answer")
  if (!sessionStateIdentity({ backend: "opencode", serverUrl: "http://127.0.0.1:4096", id: "event", sessionId: "session" }).endsWith(":session")) throw new Error("event session identity failed")
  if (parseCommand("/remove 2").arg !== 2) throw new Error("parse remove failed")
  if (parseCommand("hello") !== null) throw new Error("free text must not execute")
  if (loopbackBase("http://127.0.0.1:4096/path") !== "http://127.0.0.1:4096") throw new Error("loopback normalize failed")
  if (telegramApiRoot() !== "https://api.telegram.org") throw new Error("official Telegram API root failed")
  if (telegramApiRoot("http://127.0.0.1:8080/mock/") !== "http://127.0.0.1:8080/mock") throw new Error("loopback Telegram API root failed")
  if (permissionToken("http://127.0.0.1:4096", "request-1").length !== 16) throw new Error("permission token invalid")
  if (permissionToken("http://127.0.0.1:4096/path", "request-1") !== permissionToken("http://127.0.0.1:4096", "request-1")) throw new Error("permission token normalization failed")
  let rejected = false
  try { loopbackBase("https://example.com") } catch { rejected = true }
  if (!rejected) throw new Error("remote server must be rejected")
  rejected = false
  try { telegramApiRoot("https://example.com") } catch { rejected = true }
  if (!rejected) throw new Error("untrusted Telegram API root must be rejected")
  const project = resolveCodexProject({ Hub: "C:\\work\\hub" }, "hub")
  if (project?.alias !== "Hub" || project.directory !== resolve("C:\\work\\hub")) throw new Error("Codex project alias resolution failed")
  if (resolveCodexProject({ bad: "relative/path" }, "bad") !== null) throw new Error("relative Codex project path must be rejected")
  console.log("SELF_TEST=PASS")
}

const mode = process.argv[2] || "run"
if (mode === "--self-test") selfTest()
else if (mode === "--check") await check()
else if (mode === "--home-check") await main({ homeCheck: true })
else {
  ensureDirectories()
  try {
    acquireLock()
    const cleanup = async () => { await Promise.allSettled([codexClient?.stop(), zcodeClient?.stop()]); releaseLock(); process.exit(0) }
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
    await main()
  } catch (error) {
    log("FATAL", error.stack || error.message)
    console.error(redact(error.message))
    releaseLock()
    process.exitCode = 1
  }
}
