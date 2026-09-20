import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createI18n } from "./locales.mjs"

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

export function parseCommand(text) {
  const value = String(text || "").trim()
  let match
  if (/^\/(start|help)(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "help" }
  if (/^\/status(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "status" }
  if ((match = value.match(/^\/sessions(?:@[A-Za-z0-9_]+)?(?:\s+([1-9]\d{0,3}))?$/i))) return { name: "sessions", arg: Number.parseInt(match[1] || "1", 10) }
  if ((match = value.match(/^\/find(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,120})$/i))) return { name: "find", arg: match[1].trim() }
  if ((match = value.match(/^\/use(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,80})$/i))) return { name: "use", arg: match[1] }
  if (/^\/current(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "current" }
  if (/^\/show(?:@[A-Za-z0-9_]+)?$/i.test(value)) return { name: "show" }
  if ((match = value.match(/^\/send(?:@[A-Za-z0-9_]+)?\s+([\s\S]{1,3500})$/i))) return { name: "send", arg: match[1].trim() }
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
  return null
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
  const elapsed = Math.max(0, end - Date.parse(start || 0))
  const seconds = Math.round(elapsed / 1000)
  if (seconds < 60) return t("seconds", seconds)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? t("minuteSeconds", minutes, rest) : t("minutes", minutes)
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

function loadInstances() {
  const now = Date.now()
  return readdirSync(instancesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(join(instancesDir, entry.name)))
    .filter(Boolean)
    .filter((item) => now - Date.parse(item.updatedAt || 0) < 7 * 86400000)
    .filter((item) => {
      if (!Number.isInteger(Number(item.pid))) return true
      try { process.kill(Number(item.pid), 0); return true } catch { return false }
    })
    .filter((item) => { try { loopbackBase(item.serverUrl); return true } catch { return false } })
}

async function discoverSessions() {
  const combined = new Map()
  for (const instance of loadInstances()) {
    try {
      const query = new URLSearchParams({ directory: instance.directory || "" })
      const base = loopbackBase(instance.serverUrl)
      const [sessions, statuses] = await Promise.all([
        requestJson(`${base}/session?${query}`, { headers: openCodeHeaders(instance) }),
        requestJson(`${base}/session/status?${query}`, { headers: openCodeHeaders(instance) }).catch(() => ({})),
      ])
      for (const info of Array.isArray(sessions) ? sessions : []) {
        const item = {
          id: info.id,
          title: info.title || t("unnamedSession"),
          directory: info.directory || instance.directory,
          updated: info.time?.updated || info.time?.created || 0,
          serverUrl: base,
          status: statuses?.[info.id]?.type || "idle",
          summary: info.summary || null,
          auth: instance.auth || null,
        }
        const previous = combined.get(item.id)
        if (!previous || item.updated > previous.updated) combined.set(item.id, item)
      }
    } catch (error) {
      log("WARN", `OpenCode instance unavailable ${instance.serverUrl}: ${error.message}`)
    }
  }
  return [...combined.values()].sort((a, b) => b.updated - a.updated)
}

function latestAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role !== "assistant") continue
    const value = (messages[i].parts || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").trim()
    if (value) return value
  }
  return t("noAssistantReply")
}

async function getSessionView(session) {
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

async function main() {
  ensureDirectories()
  if (!existsSync(configPath)) throw new Error(`Not configured: ${configPath}`)
  const config = readJson(configPath)
  if (!config?.allowedUserId || !config?.allowedChatId || !config?.botTokenProtected) throw new Error("Incomplete Agent Task Hub configuration")
  i18n = createI18n(config.language || "en-US")
  const botToken = decryptToken()
  const apiBase = `https://api.telegram.org/bot${botToken}`
  const botCommands = i18n.commands()
  const state = readJson(statePath, { updateOffset: 0, selected: null, sessionMap: [] })
  state.queues ||= {}
  state.queueInFlight ||= {}
  state.queuePaused ||= {}
  state.queueStartOnIdle ||= {}
  state.processedEventIds ||= []
  state.recentEvents ||= {}
  state.sessionBrowser ||= { mode: "sessions", query: "", page: 1 }
  state.permissionRequests ||= {}
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
    return telegram("sendMessage", { chat_id: String(config.allowedChatId), text: compact(text, 3900), ...extra })
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
      const directory = String(instance.directory || "")
      const scope = `${base}\n${directory}`
      try {
        const query = new URLSearchParams({ directory })
        const list = await requestJson(`${base}/permission?${query}`, { headers: openCodeHeaders(instance) }, 5000)
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
        log("WARN", `permission scan unavailable ${base}: ${error.message}`)
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

  function authorizedMessage(message) {
    return message?.chat?.type === "private" && String(message.from?.id) === String(config.allowedUserId) && String(message.chat?.id) === String(config.allowedChatId)
  }

  function authorizedCallback(query) {
    return query?.message?.chat?.type === "private"
      && String(query.from?.id) === String(config.allowedUserId)
      && String(query.message.chat?.id) === String(config.allowedChatId)
  }

  function saveState() { atomicJson(statePath, state) }

  function recordError(scope, error) {
    state.lastError = { scope, message: compact(error?.message || error, 500), at: new Date().toISOString() }
    saveState()
  }

  function rememberEvent(event) {
    const id = String(event.id || "")
    if (id && !state.processedEventIds.includes(id)) state.processedEventIds.push(id)
    state.processedEventIds = state.processedEventIds.slice(-500)
    if (event.sessionId) state.recentEvents[event.sessionId] = { fingerprint: eventFingerprint(event), at: event.createdAt || new Date().toISOString() }
    saveState()
  }

  function eventAlreadyHandled(event, activeQueueItem = null) {
    if (event.id && state.processedEventIds.includes(String(event.id))) return true
    if (activeQueueItem && Date.parse(event.createdAt || 0) >= Date.parse(activeQueueItem.dispatchedAt || 0)) return false
    const recent = event.sessionId ? state.recentEvents[event.sessionId] : null
    return Boolean(recent
      && recent.fingerprint === eventFingerprint(event)
      && Math.abs(Date.parse(event.createdAt || 0) - Date.parse(recent.at || 0)) < 15000)
  }

  function waitingQueue(sessionId) {
    if (!Array.isArray(state.queues[sessionId])) state.queues[sessionId] = []
    return state.queues[sessionId]
  }

  async function currentSessionStatus(session) {
    try {
      const statuses = await requestSessionJson(session, "/session/status")
      return statuses?.[session.id]?.type || "idle"
    } catch {
      return "unavailable"
    }
  }

  async function dispatchNext(session) {
    const queue = waitingQueue(session.id)
    if (state.queuePaused[session.id] || state.queueInFlight[session.id] || queue.length === 0) return null
    const item = queue.shift()
    item.dispatchedAt = new Date().toISOString()
    item.dispatchState = "dispatching"
    state.queueInFlight[session.id] = item
    state.queueStartOnIdle[session.id] = false
    saveState()
    try {
      await requestSessionJson(session, `/session/${encodeURIComponent(session.id)}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: item.text }] }),
      })
      item.dispatchState = "sent"
      item.sentAt = new Date().toISOString()
      state.queueInFlight[session.id] = item
      saveState()
      log("AUDIT", `queue dispatched session=${session.id} item=${item.id} remaining=${queue.length}`)
      return { item, remaining: queue.length }
    } catch (error) {
      queue.unshift(item)
      delete state.queueInFlight[session.id]
      saveState()
      throw error
    }
  }

  function queueSummary(session) {
    const queue = waitingQueue(session.id)
    const active = state.queueInFlight[session.id]
    const paused = Boolean(state.queuePaused[session.id])
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
    return compact(t("health", openCode, instances.length, sessions.length, state.selected?.title || t("notSelected"), approvals, running, waiting, paused, durationText(startedAt), lastError))
  }

  async function selectSession(session) {
    state.selected = { id: session.id, title: session.title, directory: session.directory, serverUrl: loopbackBase(session.serverUrl), status: session.status || "idle", auth: session.auth || null }
    saveState()
    await send(t("selected", session.title, session.id, session.directory))
  }

  async function commandSessions(page = 1, query = "") {
    const all = await discoverSessions()
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
    state.sessionBrowser = { mode: needle ? "find" : "sessions", query: String(query || "").trim(), page: currentPage }
    saveState()
    if (!filtered.length) return send(needle ? t("noSearch", compact(query, 80)) : t("noSessions"))
    const lines = sessions.map((item, index) => {
      const selectedMark = state.selected?.id === item.id ? "✅ " : ""
      return `${index + 1}. ${selectedMark}[${item.status}] ${item.title}\n   ${item.directory}`
    })
    const keyboard = sessions.map((item, index) => [{
      text: `${state.selected?.id === item.id ? "✅ " : ""}${index + 1}. ${item.title}`.slice(0, 52),
      callback_data: `select:${item.id}`,
    }])
    const nav = []
    const prefix = needle ? "findpage" : "sessionspage"
    if (currentPage > 1) nav.push({ text: t("previous"), callback_data: `${prefix}:${currentPage - 1}` })
    nav.push({ text: `${currentPage}/${pageCount}`, callback_data: "noop" })
    if (currentPage < pageCount) nav.push({ text: t("next"), callback_data: `${prefix}:${currentPage + 1}` })
    keyboard.push(nav)
    const heading = needle ? t("searchHeading", compact(query, 80)) : t("sessionsHeading")
    await send(t("page", heading, filtered.length, currentPage, pageCount, lines.join("\n")), { reply_markup: { inline_keyboard: keyboard } })
  }

  async function resolveSelected() {
    if (!state.selected) return null
    loopbackBase(state.selected.serverUrl)
    return state.selected
  }

  async function handleCommand(command) {
    if (!command) return send(t("unknownCommand"))
    if (command.name === "help") return send(t("help"))
    if (command.name === "status") return send(t("status", loadInstances().length, state.selected?.title || t("notSelected")))
    if (command.name === "health") return send(await healthText())
    if (command.name === "approvals") {
      await refreshPermissions()
      const pending = Object.entries(state.permissionRequests).filter(([, item]) => !item.resolvedAt)
      if (!pending.length) return send(t("noApprovals"))
      for (const [token, item] of pending.slice(0, 10)) await sendPermissionRequest(token, item, true)
      return
    }
    if (command.name === "sessions") return commandSessions(command.arg || 1)
    if (command.name === "find") return commandSessions(1, command.arg)
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
    const selected = await resolveSelected()
    if (command.name === "current") return selected ? send(t("current", selected.title, selected.id, selected.directory)) : send(t("selectFirst"))
    if (!selected) return send(t("selectFirst"))
    if (command.name === "show") return send(await getSessionView(selected))
    if (command.name === "queue") return send(queueSummary(selected))
    if (command.name === "add") {
      const queue = waitingQueue(selected.id)
      const limit = Number(config.queueLimit || 20)
      const occupied = queue.length + (state.queueInFlight[selected.id] ? 1 : 0)
      if (occupied >= limit) return send(t("queueFull", limit))
      const [item] = makeQueueItems([command.arg])
      queue.push(item)
      saveState()
      const status = await currentSessionStatus(selected)
      if (status === "idle" && !state.queuePaused[selected.id] && !state.queueInFlight[selected.id]) {
        try {
          const started = await dispatchNext(selected)
          if (started) return send(t("addStarted", compact(started.item.text, 500), started.remaining))
        } catch (error) {
          return send(t("savedStartFailed", compact(error.message, 300)))
        }
      }
      state.queueStartOnIdle[selected.id] = status !== "idle"
      saveState()
      return send(t("added", status, queue.length))
    }
    if (command.name === "batch") {
      const queue = waitingQueue(selected.id)
      const limit = Number(config.queueLimit || 20)
      let parts
      try { parts = parseBatch(command.arg, limit) } catch (error) { return send(error.message) }
      const occupied = queue.length + (state.queueInFlight[selected.id] ? 1 : 0)
      if (occupied + parts.length > limit) return send(t("batchCapacity", limit, Math.max(0, limit - occupied)))
      queue.push(...makeQueueItems(parts))
      saveState()
      const status = await currentSessionStatus(selected)
      if (status === "idle" && !state.queuePaused[selected.id] && !state.queueInFlight[selected.id]) {
        try {
          const started = await dispatchNext(selected)
          if (started) return send(t("batchStarted", parts.length, compact(started.item.text, 500), started.remaining))
        } catch (error) {
          return send(t("batchSavedFailed", parts.length, compact(error.message, 300)))
        }
      }
      state.queueStartOnIdle[selected.id] = status !== "idle"
      saveState()
      return send(t("batchAdded", parts.length, status, queue.length))
    }
    if (command.name === "remove") {
      const queue = waitingQueue(selected.id)
      const index = command.arg - 1
      if (index < 0 || index >= queue.length) return send(t("badQueueIndex"))
      const [removed] = queue.splice(index, 1)
      saveState()
      return send(t("removed", compact(removed.text, 500)))
    }
    if (command.name === "pause") {
      state.queuePaused[selected.id] = true
      saveState()
      return send(t("paused"))
    }
    if (command.name === "resume") {
      state.queuePaused[selected.id] = false
      saveState()
      const status = await currentSessionStatus(selected)
      if (status === "idle" && !state.queueInFlight[selected.id]) {
        try {
          const started = await dispatchNext(selected)
          if (started) return send(t("resumedStarted", compact(started.item.text, 500), started.remaining))
        } catch (error) {
          return send(t("resumedFailed", compact(error.message, 300)))
        }
      }
      state.queueStartOnIdle[selected.id] = status !== "idle" && waitingQueue(selected.id).length > 0
      saveState()
      return send(t("resumed", status))
    }
    if (command.name === "clearqueue") {
      const count = waitingQueue(selected.id).length
      if (!count) return send(t("queueEmpty"))
      return send(t("confirmClear", count), { reply_markup: { inline_keyboard: [[{ text: t("confirmClearButton"), callback_data: `clearq:${selected.id}` }, { text: t("cancel"), callback_data: "cancel" }]] } })
    }
    if (command.name === "send") {
      const id = encodeURIComponent(selected.id)
      await requestSessionJson(selected, `/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: command.arg }] }),
      })
      return send(t("sent"))
    }
    if (command.name === "stop") {
      return send(t("confirmStop", selected.title), { reply_markup: { inline_keyboard: [[{ text: t("confirmStopButton"), callback_data: `abort:${selected.id}` }, { text: t("cancel"), callback_data: "cancel" }]] } })
    }
  }

  async function handleCallback(query) {
    if (!authorizedCallback(query)) {
      log("AUDIT", `ignored unauthorized callback user=${query?.from?.id || "unknown"}`)
      return
    }
    const data = String(query.data || "")
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
            text: compact(text, 3900),
            reply_markup: { inline_keyboard: [] },
          }).catch((error) => log("WARN", `unable to update permission message: ${error.message}`))
        }
      }
      else if (data === "noop") await telegram("answerCallbackQuery", { callback_query_id: query.id })
      else if (data === "cancel") await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("cancelled") })
      else if (data.startsWith("sessionspage:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        await commandSessions(Number.parseInt(data.slice(13), 10) || 1)
      } else if (data.startsWith("findpage:")) {
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        await commandSessions(Number.parseInt(data.slice(9), 10) || 1, state.sessionBrowser?.query || "")
      }
      else if (data.startsWith("select:")) {
        const id = data.slice(7)
        const session = (await discoverSessions()).find((item) => item.id === id)
        if (!session) throw new Error(t("sessionUnavailable"))
        await selectSession(session)
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("setCurrent") })
      } else if (data.startsWith("show:")) {
        const id = data.slice(5)
        const session = (await discoverSessions()).find((item) => item.id === id)
        if (!session) throw new Error(t("sessionUnavailable"))
        await send(await getSessionView(session))
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("detailSent") })
      } else if (data.startsWith("addhelp:")) {
        const id = data.slice(8)
        const session = (await discoverSessions()).find((item) => item.id === id)
        if (!session) throw new Error(t("sessionUnavailable"))
        state.selected = { id: session.id, title: session.title, directory: session.directory, serverUrl: loopbackBase(session.serverUrl), status: session.status || "idle", auth: session.auth || null }
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("setCurrent") })
        await send(t("addHelp", session.title))
      } else if (data.startsWith("queue:")) {
        const id = data.slice(6)
        const session = (await discoverSessions()).find((item) => item.id === id)
        if (!session) throw new Error(t("sessionUnavailable"))
        await send(queueSummary(session))
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("queueSent") })
      } else if (data.startsWith("stopask:")) {
        const id = data.slice(8)
        const session = (await discoverSessions()).find((item) => item.id === id)
        if (!session) throw new Error(t("sessionUnavailable"))
        await telegram("answerCallbackQuery", { callback_query_id: query.id })
        await send(t("confirmStop", session.title), { reply_markup: { inline_keyboard: [[{ text: t("confirmStopButton"), callback_data: `abort:${session.id}` }, { text: t("cancel"), callback_data: "cancel" }]] } })
      } else if (data.startsWith("abort:")) {
        const id = data.slice(6)
        const selected = (await discoverSessions()).find((item) => item.id === id)
        if (!selected) throw new Error(t("sessionUnavailable"))
        state.queuePaused[id] = true
        state.queueStartOnIdle[id] = false
        saveState()
        await requestSessionJson(selected, `/session/${encodeURIComponent(id)}/abort`, { method: "POST" })
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("stopRequested") })
        await send(t("stopDone"))
      } else if (data.startsWith("clearq:")) {
        const id = data.slice(7)
        const selected = await resolveSelected()
        if (!selected || selected.id !== id) throw new Error(t("currentChanged"))
        state.queues[id] = []
        saveState()
        await telegram("answerCallbackQuery", { callback_query_id: query.id, text: t("queueCleared") })
        await send(t("queueClearedDetail"))
      }
    } catch (error) {
      await telegram("answerCallbackQuery", { callback_query_id: query.id, text: compact(error.message, 120), show_alert: true }).catch(() => {})
    }
  }

  async function processUpdate(update) {
    if (update.callback_query) return handleCallback(update.callback_query)
    const message = update.message
    if (!authorizedMessage(message) || typeof message.text !== "string") {
      if (message) log("AUDIT", `rejected Telegram message user=${message.from?.id} chat=${message.chat?.id} type=${message.chat?.type}`)
      return
    }
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
    const current = state.selected?.id === event.sessionId
    return { reply_markup: { inline_keyboard: [
      [{ text: current ? t("currentSession") : t("setAsCurrent"), callback_data: `select:${event.sessionId}` }, { text: t("viewDetails"), callback_data: `show:${event.sessionId}` }],
      [{ text: t("append"), callback_data: `addhelp:${event.sessionId}` }, { text: t("viewQueue"), callback_data: `queue:${event.sessionId}` }],
      [{ text: t("stopTask"), callback_data: `stopask:${event.sessionId}` }],
    ] } }
  }

  function pendingCompletionExists(sessionId, dispatchedAt) {
    return readdirSync(eventsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .some((entry) => {
        const event = readJson(join(eventsDir, entry.name))
        return event?.sessionId === sessionId && Date.parse(event.createdAt || 0) >= Date.parse(dispatchedAt || 0)
      })
  }

  async function recentSessionMessages(session, limit = 30) {
    return requestJson(sessionUrl(session, `/session/${encodeURIComponent(session.id)}/message`) + `&limit=${limit}`, { headers: openCodeHeaders(session) })
  }

  function messageTimestamp(message) {
    let value = Number(message?.info?.time?.completed || message?.info?.time?.updated || message?.info?.time?.created || 0)
    if (value > 0 && value < 1e12) value *= 1000
    return value
  }

  function messageText(message) {
    return (message?.parts || []).filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").trim()
  }

  async function synthesizeRecoveredCompletion(session, item) {
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
    const payload = {
      version: 1,
      id: `recovered-${randomUUID()}`,
      type: "session.idle",
      createdAt: new Date().toISOString(),
      sessionId: session.id,
      title: session.title,
      directory: session.directory,
      serverUrl: session.serverUrl,
      summary: session.summary || null,
      excerpt: assistant ? messageText(assistant).slice(0, 1800) : "",
      recovered: true,
    }
    atomicJson(join(eventsDir, `${Date.now()}-${payload.id}.json`), payload)
    return true
  }

  async function reconcileQueues() {
    const activeEntries = Object.entries(state.queueInFlight)
    if (!activeEntries.length) return
    const sessions = await discoverSessions()
    const byId = new Map(sessions.map((session) => [session.id, session]))
    for (const [sessionId, item] of activeEntries) {
      const session = byId.get(sessionId)
      if (!session) continue
      const status = await currentSessionStatus(session)
      if (status !== "idle") continue
      if (pendingCompletionExists(sessionId, item.dispatchedAt)) continue
      try {
        if (await synthesizeRecoveredCompletion(session, item)) {
          log("INFO", `recovered completed queue item session=${sessionId} item=${item.id}`)
          continue
        }
        waitingQueue(sessionId).unshift(item)
        delete state.queueInFlight[sessionId]
        saveState()
        if (!state.queuePaused[sessionId]) await dispatchNext(session)
      } catch (error) {
        recordError("queue-recovery", error)
        log("WARN", `queue recovery failed session=${sessionId}: ${error.message}`)
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
      try {
        await refreshPermissions()
      } catch (error) {
        recordError("permission-monitor", error)
        log("WARN", `permission monitor failed: ${error.message}`)
      }
      await sleep(5000)
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
        if (Date.now() - Date.parse(event.createdAt || 0) > 7 * 86400000) { rmSync(path, { force: true }); continue }
        const activeQueueItem = event.sessionId ? state.queueInFlight[event.sessionId] : null
        const matchesQueue = Boolean(activeQueueItem && Date.parse(event.createdAt || 0) >= Date.parse(activeQueueItem.dispatchedAt || 0))
        if (eventAlreadyHandled(event, matchesQueue ? activeQueueItem : null)) {
          rmSync(path, { force: true })
          log("INFO", `duplicate completion ignored event=${event.id || name} session=${event.sessionId || "none"}`)
          continue
        }
        const waiting = event.sessionId ? waitingQueue(event.sessionId).length : 0
        const isError = event.type === "session.error"
        let queueNote = t("manualSource")
        if (matchesQueue) {
          const progress = activeQueueItem.batchTotal > 1 ? t("itemProgress", activeQueueItem.batchIndex, activeQueueItem.batchTotal) : t("queueItem")
          const next = waitingQueue(event.sessionId)[0]
          queueNote = t("queueProgress", progress, isError ? t("executionFailed") : t("completed"), durationText(activeQueueItem.dispatchedAt, Date.parse(event.createdAt || Date.now())), waiting, next ? t("nextTask", compact(next.text, 180)) : "")
          if (isError) queueNote += t("queueAutoPaused")
        } else if (event.sessionId && state.queueStartOnIdle[event.sessionId] && waiting) {
          queueNote += t("waitingWillStart", waiting)
        }
        const icon = isError ? "❌" : "✅"
        const stats = event.summary ? t("changeStats", event.summary.files || 0, event.summary.additions || 0, event.summary.deletions || 0) : ""
        const detail = isError ? t("error", event.error || t("unknownError")) : event.excerpt ? t("latestReply", event.excerpt) : ""
        const text = compact(t("completion", icon, isError ? t("executionFailed") : t("taskCompleted"), event.title, event.directory, stats, queueNote, detail))
        try {
          await send(text, completionButtons(event))
          if (matchesQueue) {
            delete state.queueInFlight[event.sessionId]
            if (isError) {
              state.queuePaused[event.sessionId] = true
              state.queueStartOnIdle[event.sessionId] = false
            }
          }
          rememberEvent(event)
          rmSync(path, { force: true })
          const shouldStart = event.sessionId && event.type === "session.idle" && waiting && !state.queuePaused[event.sessionId]
            && (matchesQueue || state.queueStartOnIdle[event.sessionId])
          if (shouldStart) {
            state.queueStartOnIdle[event.sessionId] = false
            saveState()
            try {
              await dispatchNext({ id: event.sessionId, title: event.title, directory: event.directory, serverUrl: event.serverUrl })
            } catch (error) {
              recordError("queue-dispatch", error)
              await send(t("nextFailed", compact(error.message, 300))).catch(() => {})
            }
          } else if (matchesQueue && !isError && waiting === 0) {
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

  try {
    await configureTelegram(true)
  } catch (error) {
    recordError("telegram-startup", error)
    log("WARN", `Telegram startup connection failed; retrying without exiting: ${error.message}`)
  }
  await Promise.all([telegramLoop(), eventLoop(), recoveryLoop(), permissionLoop()])
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
  if (!["add", "batch", "find", "health", "approvals"].every((name) => commandNames.has(name))) throw new Error("Telegram command menu is incomplete")
  const sessions = await discoverSessions()
  console.log(`CHECK=PASS BOT=@${result.result.username} INSTANCES=${loadInstances().length} SESSIONS=${sessions.length} COMMANDS=add,batch,find,health,approvals`)
}

function selfTest() {
  if (parseCommand("/sessions").name !== "sessions") throw new Error("parse sessions failed")
  if (parseCommand("/sessions 2").arg !== 2) throw new Error("parse sessions page failed")
  if (parseCommand("/find paper project").arg !== "paper project") throw new Error("parse find failed")
  if (parseCommand("/health").name !== "health") throw new Error("parse health failed")
  if (parseCommand("/approvals").name !== "approvals") throw new Error("parse approvals failed")
  if (parseCommand("/send 继续运行测试").arg !== "继续运行测试") throw new Error("parse send failed")
  if (parseCommand("/add 先运行测试").name !== "add") throw new Error("parse add failed")
  if (parseCommand("/batch 先运行测试\n---\n再写文档").name !== "batch") throw new Error("parse batch failed")
  if (parseBatch("先运行测试\n---\n再写文档").length !== 2) throw new Error("split batch failed")
  if (eventFingerprint({ type: "session.idle", sessionId: "s", excerpt: "ok" }) !== eventFingerprint({ id: "other", type: "session.idle", sessionId: "s", excerpt: "ok" })) throw new Error("event fingerprint unstable")
  if (eventFingerprint({ type: "session.idle", sessionId: "s", excerpt: "ok" }) === eventFingerprint({ type: "session.idle", sessionId: "s", excerpt: "different" })) throw new Error("event fingerprint collision")
  if (parseCommand("/remove 2").arg !== 2) throw new Error("parse remove failed")
  if (parseCommand("hello") !== null) throw new Error("free text must not execute")
  if (loopbackBase("http://127.0.0.1:4096/path") !== "http://127.0.0.1:4096") throw new Error("loopback normalize failed")
  if (permissionToken("http://127.0.0.1:4096", "request-1").length !== 16) throw new Error("permission token invalid")
  if (permissionToken("http://127.0.0.1:4096/path", "request-1") !== permissionToken("http://127.0.0.1:4096", "request-1")) throw new Error("permission token normalization failed")
  let rejected = false
  try { loopbackBase("https://example.com") } catch { rejected = true }
  if (!rejected) throw new Error("remote server must be rejected")
  console.log("SELF_TEST=PASS")
}

const mode = process.argv[2] || "run"
if (mode === "--self-test") selfTest()
else if (mode === "--check") await check()
else {
  ensureDirectories()
  try {
    acquireLock()
    const cleanup = () => { releaseLock(); process.exit(0) }
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
