import assert from "node:assert/strict"
import { confirmQueueUncertainty, queueUncertaintySnapshot } from "../app/queue-uncertainty.mjs"

const key = "pi:cccccccccccc:session-1"
const otherKey = "pi:dddddddddddd:session-2"
const uncertain = { id: "uncertain-1", text: "previous instruction", dispatchState: "uncertain", dispatchedAt: "2026-10-03T00:00:00Z" }
const pending = { id: "waiting-1", text: "next instruction" }
const recovery = {
  sessionId: "session-1", sessionFile: "C:\\work\\session.jsonl",
  uncertainItems: [{ sourceKey: "pi:aaaaaaaaaaaa:session-1", item: { id: "old-1", text: "old instruction", dispatchState: "sent" } }],
  conflictingItems: [{ sourceKey: "pi:bbbbbbbbbbbb:session-1", item: { id: "conflict-1", text: "different instruction" }, reason: "instruction-id-conflict" }],
}
const confirmedAt = "2026-10-03T01:00:00Z"
const state = { queueInFlight: { [key]: uncertain }, queues: { [key]: [pending] }, piQueueRecovery: { [key]: recovery } }
const before = structuredClone(state)
const snapshot = queueUncertaintySnapshot(state, key)
assert.equal(snapshot.count, 3)
assert.equal(snapshot.fingerprint.length, 24)
assert.deepEqual(state, before, "snapshot must not mutate state")
snapshot.items[0].item.text = "mutating a UI snapshot cannot change the queue"
assert.deepEqual(state, before)
const stable = queueUncertaintySnapshot(state, key).fingerprint
const reordered = structuredClone(state)
reordered.queueInFlight[key] = { text: uncertain.text, dispatchedAt: uncertain.dispatchedAt, dispatchState: uncertain.dispatchState, id: uncertain.id }
assert.equal(queueUncertaintySnapshot(reordered, key).fingerprint, stable, "object insertion order is not an identity change")
assert.notEqual(queueUncertaintySnapshot({ ...state, queueInFlight: { [otherKey]: uncertain }, piQueueRecovery: { [otherKey]: recovery } }, otherKey).fingerprint, stable)

const accepted = confirmQueueUncertainty(state, key, stable, { confirmedAt })
assert.deepEqual(accepted, { confirmed: true, changed: true, reason: "acknowledged", archivedCount: 3 })
assert.equal(state.queueInFlight[key], undefined)
assert.equal(state.piQueueRecovery[key], undefined)
assert.deepEqual(state.queues[key], [pending], "acknowledgement must not append old instructions or dispatch waiting work")
assert.equal(state.queuePaused[key], true)
assert.equal(state.queueStartOnIdle[key], false)
assert.deepEqual(state.queueUncertaintyHistory.map((entry) => entry.item.id), ["uncertain-1", "old-1", "conflict-1"])
assert.ok(state.queueUncertaintyHistory.every((entry) => entry.confirmedAt === confirmedAt && entry.sessionKey === key))
const after = structuredClone(state)
assert.equal(confirmQueueUncertainty(state, key, stable).reason, "nothing-pending")
assert.deepEqual(state, after, "double-click must not archive or mutate twice")

// A button generated before a new uncertain item arrived cannot clear that item.
for (const mutate of [
  (value) => { value.queueInFlight[key].id = "new-attempt" },
  (value) => { value.piQueueRecovery[key].uncertainItems.push({ sourceKey: "old", item: { id: "late", text: "late task" } }) },
  (value) => { value.piQueueRecovery[key].conflictingItems[0].item.text = "changed" },
]) {
  const stale = structuredClone(before)
  const fingerprint = queueUncertaintySnapshot(stale, key).fingerprint
  mutate(stale)
  const changedState = structuredClone(stale)
  assert.equal(confirmQueueUncertainty(stale, key, fingerprint).reason, "stale-confirmation")
  assert.deepEqual(stale, changedState)
}

// Keep the currently running task and all unrelated sessions exactly as they are.
const live = { id: "live", text: "currently executing", dispatchState: "sent" }
const withLive = { queueInFlight: { [key]: live, [otherKey]: uncertain }, piQueueRecovery: { [key]: recovery }, queues: { [key]: [pending], [otherKey]: [pending] } }
const liveSnapshot = queueUncertaintySnapshot(withLive, key)
assert.equal(liveSnapshot.count, 2)
confirmQueueUncertainty(withLive, key, liveSnapshot.fingerprint, { confirmedAt })
assert.deepEqual(withLive.queueInFlight[key], live)
assert.deepEqual(withLive.queueInFlight[otherKey], uncertain)
assert.deepEqual(withLive.queues[otherKey], [pending])
assert.equal(withLive.queuePaused[otherKey], undefined)
for (const dispatchState of ["dispatching", "sent"]) {
  const normal = { queueInFlight: { [key]: { ...live, dispatchState } } }
  const original = structuredClone(normal)
  assert.equal(queueUncertaintySnapshot(normal, key).count, 0)
  assert.equal(confirmQueueUncertainty(normal, key, "anything").reason, "nothing-pending")
  assert.deepEqual(normal, original)
}

// Audit history is bounded, retaining the newest attempts and complete payloads.
const bounded = structuredClone(before)
bounded.queueUncertaintyHistory = Array.from({ length: 100 }, (_, index) => ({ marker: index }))
confirmQueueUncertainty(bounded, key, queueUncertaintySnapshot(bounded, key).fingerprint, { confirmedAt })
assert.equal(bounded.queueUncertaintyHistory.length, 100)
assert.equal(bounded.queueUncertaintyHistory[0].marker, 3)
assert.equal(bounded.queueUncertaintyHistory.at(-1).item.text, "different instruction")
console.log("QUEUE_UNCERTAINTY_TEST=PASS")
