import { posix, win32 } from "node:path"
import { sessionIdentity } from "./agent-context.mjs"

const collections = ["queues", "queueInFlight", "queuePaused", "queueStartOnIdle", "piQueueRecovery"]
const parseKey = (key) => /^pi:([^:]+):(.+)$/.exec(key)
const clone = (value) => structuredClone(value)
const sessionId = (value) => String(value?.sessionId || value?.id || "")

// No filesystem access: callers supply catalog/history paths (prefer real paths).
// Relative paths are not evidence of identity. Windows paths are case-insensitive.
export function normalizePiSessionFile(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null
  if (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)) return win32.normalize(value).toLowerCase()
  if (value.startsWith("/")) return posix.normalize(value)
  return null
}

const equivalentItem = (left, right) => Boolean(left?.id && left.id === right?.id && left.text === right.text)

/**
 * Deterministic state reconciliation without I/O, dispatch, or clock access.
 * Mutates the supplied state; the caller must persist it before any dispatch.
 * An old in-flight item is never put back in queues. Unknown executions and
 * conflicting instruction IDs are held for explicit confirmation, even when
 * the new process currently reports idle or a newer completion.
 */
export function reconcilePiQueueInstances(state, sessions, historyEntries = []) {
  const result = { changed: false, migrations: [], conflicts: [] }
  const piSessions = (Array.isArray(sessions) ? sessions : []).filter((item) => item?.backend === "pi")
  const live = piSessions.filter((item) => item.instanceId && ["idle", "busy", "running"].includes(item.status))
  const liveKeys = new Set(live.map(sessionIdentity))
  const evidence = new Map()
  const addEvidence = (id, value) => {
    const path = normalizePiSessionFile(value)
    if (!id || !path) return
    if (!evidence.has(id)) evidence.set(id, new Set())
    evidence.get(id).add(path)
  }
  for (const entry of [...piSessions, ...(Array.isArray(historyEntries) ? historyEntries : [])]) {
    addEvidence(sessionId(entry), entry?.sessionFile)
  }
  for (const [key, recovery] of Object.entries(state.piQueueRecovery || {})) {
    const parsed = parseKey(key)
    if (parsed) addEvidence(parsed[2], recovery?.sessionFile)
  }

  const keys = [...new Set(collections.flatMap((name) => Object.keys(state[name] || {})))].sort()
  for (const sourceKey of keys) {
    const parsed = parseKey(sourceKey)
    if (!parsed || liveKeys.has(sourceKey)) continue
    const sourceQueue = Array.isArray(state.queues?.[sourceKey]) ? state.queues[sourceKey] : []
    const sourceInFlight = state.queueInFlight?.[sourceKey]
    const sourceRecovery = state.piQueueRecovery?.[sourceKey]
    if (!sourceQueue.length && !sourceInFlight && !sourceRecovery) continue
    const id = parsed[2]
    const paths = evidence.get(id)
    if (!paths || paths.size !== 1) {
      result.conflicts.push({ sourceKey, reason: paths?.size > 1 ? "ambiguous-session-file" : "missing-session-file" })
      continue
    }
    const [sessionFile] = paths
    const candidates = live.filter((item) => sessionId(item) === id && normalizePiSessionFile(item.sessionFile) === sessionFile)
    if (candidates.length !== 1) {
      if (candidates.length > 1) result.conflicts.push({ sourceKey, reason: "multiple-live-instances" })
      continue
    }
    const targetKey = sessionIdentity(candidates[0])
    for (const name of collections) state[name] ||= {}
    const targetRecovery = state.piQueueRecovery[targetKey]
    const recovery = {
      sessionId: id, sessionFile,
      uncertainItems: clone(targetRecovery?.uncertainItems || []),
      conflictingItems: clone(targetRecovery?.conflictingItems || []),
    }
    recovery.uncertainItems.push(...clone(sourceRecovery?.uncertainItems || []))
    recovery.conflictingItems.push(...clone(sourceRecovery?.conflictingItems || []))
    if (sourceInFlight) recovery.uncertainItems.push({ sourceKey, item: clone(sourceInFlight) })

    const retained = []
    const known = [state.queueInFlight[targetKey], ...recovery.uncertainItems.map((entry) => entry.item)].filter(Boolean)
    let waitingMoved = 0
    let duplicatesSkipped = 0
    const merge = (item, origin) => {
      const previous = item?.id ? known.find((candidate) => candidate?.id === item.id) : null
      if (previous) {
        if (equivalentItem(previous, item)) duplicatesSkipped += 1
        else recovery.conflictingItems.push({ sourceKey: origin, item: clone(item), reason: "instruction-id-conflict" })
        return
      }
      retained.push(clone(item))
      known.push(item)
      if (origin === sourceKey) waitingMoved += 1
    }
    for (const item of state.queues[targetKey] || []) merge(item, targetKey)
    for (const item of sourceQueue) merge(item, sourceKey)
    state.queues[targetKey] = retained
    const needsConfirmation = recovery.uncertainItems.length > 0 || recovery.conflictingItems.length > 0
    state.queuePaused[targetKey] = Boolean(state.queuePaused[targetKey] || state.queuePaused[sourceKey] || needsConfirmation)
    state.queueStartOnIdle[targetKey] = !state.queuePaused[targetKey]
      && Boolean(state.queueStartOnIdle[targetKey] || state.queueStartOnIdle[sourceKey])
    if (needsConfirmation) state.piQueueRecovery[targetKey] = recovery
    for (const name of collections) delete state[name][sourceKey]
    result.changed = true
    result.migrations.push({
      sourceKey, targetKey, waitingMoved, duplicatesSkipped,
      uncertainCount: recovery.uncertainItems.length,
      conflictCount: recovery.conflictingItems.length,
      paused: state.queuePaused[targetKey],
    })
  }
  return result
}

export function piQueueNeedsConfirmation(state, key) {
  const recovery = state?.piQueueRecovery?.[key]
  return Boolean(recovery?.uncertainItems?.length || recovery?.conflictingItems?.length)
}
