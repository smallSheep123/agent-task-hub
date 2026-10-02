import { createHash } from "node:crypto"

const clone = (value) => structuredClone(value)
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

/** Read-only snapshot suitable for a confirmation screen and stale-button check. */
export function queueUncertaintySnapshot(state, sessionKey) {
  const key = String(sessionKey || "")
  const items = []
  const inFlight = state?.queueInFlight?.[key]
  if (inFlight?.dispatchState === "uncertain") items.push({ kind: "in-flight", sourceKey: key, item: clone(inFlight) })
  const recovery = state?.piQueueRecovery?.[key]
  for (const entry of recovery?.uncertainItems || []) {
    items.push({ ...clone(entry), kind: "pi-in-flight", sessionFile: recovery.sessionFile || null })
  }
  for (const entry of recovery?.conflictingItems || []) {
    items.push({ ...clone(entry), kind: "pi-conflict", sessionFile: recovery.sessionFile || null })
  }
  const fingerprint = items.length ? createHash("sha256")
    .update(JSON.stringify(canonical({ sessionKey: key, items, recovery: recovery || null })))
    .digest("hex").slice(0, 24) : null
  return { sessionKey: key, count: items.length, items, fingerprint }
}

/**
 * Explicitly acknowledge old uncertain attempts without executing any prompt.
 * The caller supplies the timestamp and persists the result before replying.
 * Queue resumption is intentionally a separate operation.
 */
export function confirmQueueUncertainty(state, sessionKey, expectedFingerprint, { confirmedAt = null } = {}) {
  const snapshot = queueUncertaintySnapshot(state, sessionKey)
  if (!snapshot.count) return { confirmed: false, changed: false, reason: "nothing-pending", archivedCount: 0 }
  if (!expectedFingerprint || expectedFingerprint !== snapshot.fingerprint) {
    return { confirmed: false, changed: false, reason: "stale-confirmation", archivedCount: 0 }
  }
  const history = Array.isArray(state.queueUncertaintyHistory) ? state.queueUncertaintyHistory : []
  state.queueUncertaintyHistory = [...history, ...snapshot.items.map((entry) => ({
    ...entry, sessionKey: snapshot.sessionKey, fingerprint: snapshot.fingerprint, confirmedAt,
  }))].slice(-100)
  if (state.queueInFlight?.[snapshot.sessionKey]?.dispatchState === "uncertain") delete state.queueInFlight[snapshot.sessionKey]
  if (state.piQueueRecovery) delete state.piQueueRecovery[snapshot.sessionKey]
  state.queuePaused ||= {}
  state.queueStartOnIdle ||= {}
  state.queuePaused[snapshot.sessionKey] = true
  state.queueStartOnIdle[snapshot.sessionKey] = false
  return { confirmed: true, changed: true, reason: "acknowledged", archivedCount: snapshot.count }
}
