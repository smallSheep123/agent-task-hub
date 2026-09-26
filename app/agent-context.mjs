export const AGENT_BACKENDS = Object.freeze(["opencode", "codex", "zcode", "pi"])

export function normalizeBackend(value, fallback = null) {
  const backend = String(value || "").toLowerCase()
  return AGENT_BACKENDS.includes(backend) ? backend : fallback
}

export function initializeAgentContext(state) {
  const target = state && typeof state === "object" ? state : {}
  const selectedBackend = normalizeBackend(target.selected?.backend, target.selected ? "opencode" : null)
  if (target.selected && !target.selected.backend) target.selected.backend = selectedBackend
  target.viewMode = target.viewMode === "agent" || (target.viewMode !== "global" && target.selected) ? "agent" : "global"
  target.activeBackend = normalizeBackend(target.activeBackend, selectedBackend)
  if (target.viewMode === "agent" && !target.activeBackend) target.viewMode = "global"
  return target
}

export function enterGlobalMode(state) {
  state.viewMode = "global"
  state.activeBackend = null
  return state
}

export function enterAgentMode(state, backend) {
  const normalized = normalizeBackend(backend)
  if (!normalized) throw new Error(`Unsupported agent backend: ${backend}`)
  state.viewMode = "agent"
  state.activeBackend = normalized
  return state
}

export function selectAgentSession(state, session) {
  const backend = normalizeBackend(session?.backend, "opencode")
  enterAgentMode(state, backend)
  state.selected = { ...session, backend }
  return state.selected
}

export function filterAgentSessions(sessions, backend = "all") {
  const list = Array.isArray(sessions) ? sessions : []
  if (backend === "all" || !backend) return list
  const normalized = normalizeBackend(backend)
  return normalized ? list.filter((session) => normalizeBackend(session?.backend, "opencode") === normalized) : []
}

export function sessionIdentity(session) {
  const backend = normalizeBackend(session?.backend, "opencode")
  const instance = String(session?.serverUrl || session?.instanceId || "local")
  const id = String(session?.id || session?.sessionId || "")
  return `${backend}:${instance}:${id}`
}

export function migrateSessionCollections(state, session, collectionNames = ["queues", "queueInFlight", "queuePaused", "queueStartOnIdle", "recentEvents"]) {
  const key = sessionIdentity(session)
  const legacyKey = String(session?.id || session?.sessionId || "")
  if (!legacyKey || key === legacyKey) return key
  for (const name of collectionNames) {
    const collection = state?.[name]
    if (!collection || typeof collection !== "object") continue
    if (!Object.hasOwn(collection, key) && Object.hasOwn(collection, legacyKey)) collection[key] = collection[legacyKey]
    if (Object.hasOwn(collection, legacyKey)) delete collection[legacyKey]
  }
  return key
}

export function encodeSessionAction(action, session) {
  if (!/^[a-z]{1,12}$/.test(String(action || ""))) throw new Error("Invalid callback action")
  const normalized = normalizeBackend(session?.backend, "opencode")
  const backend = normalized === "codex" ? "c" : normalized === "zcode" ? "z" : normalized === "pi" ? "p" : "o"
  // Terminal events have both an event id and a sessionId. The event id can
  // contain the thread and turn ids and exceed Telegram's 64-byte callback
  // limit, while every session action must target the underlying session.
  const id = String(session?.sessionId || session?.id || "")
  const value = `${action}:${backend}:${backend === "p" ? `${session?.instanceId}.${id}` : id}`
  if (Buffer.byteLength(value, "utf8") > 64) throw new Error("Session callback exceeds Telegram's 64-byte limit")
  return value
}

export function decodeSessionAction(value, expectedAction) {
  const text = String(value || "")
  const prefix = `${expectedAction}:`
  if (!text.startsWith(prefix)) return null
  const payload = text.slice(prefix.length)
  const modern = payload.match(/^([oczp]):(.+)$/)
  if (modern?.[1] === "p") {
    const match = modern[2].match(/^([a-f0-9]{12})\.(.+)$/)
    return match ? { backend: "pi", instanceId: match[1], id: match[2] } : null
  }
  if (modern) return { backend: modern[1] === "c" ? "codex" : modern[1] === "z" ? "zcode" : "opencode", id: modern[2] }
  return payload ? { backend: "opencode", id: payload } : null
}
