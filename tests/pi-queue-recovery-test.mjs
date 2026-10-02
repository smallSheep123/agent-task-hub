import assert from "node:assert/strict"
import { normalizePiSessionFile, piQueueNeedsConfirmation, reconcilePiQueueInstances } from "../app/pi-queue-recovery.mjs"

const file = "C:\\Users\\Example\\.pi\\agent\\sessions\\project\\chat.jsonl"
const id = "session-1"
const oldKey = `pi:aaaaaaaaaaaa:${id}`
const otherKey = `pi:bbbbbbbbbbbb:${id}`
const targetKey = `pi:cccccccccccc:${id}`
const session = { backend: "pi", instanceId: "cccccccccccc", id, sessionFile: file, status: "idle" }
const history = [{ sessionId: id, sessionFile: file }]
const queued = (id, text = id) => ({ id, text, createdAt: "2026-09-27T00:00:00Z" })
const active = (id) => ({ ...queued(id), dispatchedAt: "2026-09-27T01:00:00Z", dispatchState: "sent" })

assert.equal(normalizePiSessionFile("C:/Users/Example/../Example/.pi/chat.jsonl"), "c:\\users\\example\\.pi\\chat.jsonl")
assert.equal(normalizePiSessionFile("relative/chat.jsonl"), null)
assert.equal(normalizePiSessionFile("C:chat.jsonl"), null)

// An old execution is quarantined, not replayed; waiting work is still visible.
const state = { queues: { [oldKey]: [queued("q1")] }, queueInFlight: { [oldKey]: active("a1") }, queueStartOnIdle: { [oldKey]: true } }
const result = reconcilePiQueueInstances(state, [session], history)
assert.equal(result.changed, true)
assert.deepEqual(state.queues[targetKey], [queued("q1")])
assert.equal(state.queueInFlight[targetKey], undefined)
assert.equal(state.queueInFlight[oldKey], undefined)
assert.deepEqual(state.piQueueRecovery[targetKey].uncertainItems, [{ sourceKey: oldKey, item: active("a1") }])
assert.equal(state.queuePaused[targetKey], true)
assert.equal(state.queueStartOnIdle[targetKey], false)
assert.equal(piQueueNeedsConfirmation(state, targetKey), true)
const snapshot = structuredClone(state)
assert.equal(reconcilePiQueueInstances(state, [session], history).changed, false)
assert.deepEqual(state, snapshot, "repeated reconciliation must not duplicate recovered records")

// Both old attempts survive and the live process's existing execution is kept.
const multiple = {
  queues: { [oldKey]: [queued("q1"), queued("shared")], [otherKey]: [queued("shared"), queued("q2")], [targetKey]: [queued("current")] },
  queueInFlight: { [oldKey]: active("a1"), [otherKey]: active("a2"), [targetKey]: active("live") },
}
reconcilePiQueueInstances(multiple, [session], history)
assert.deepEqual(multiple.queueInFlight[targetKey], active("live"))
assert.deepEqual(multiple.queues[targetKey].map((item) => item.id), ["current", "q1", "shared", "q2"])
assert.deepEqual(multiple.piQueueRecovery[targetKey].uncertainItems.map((entry) => entry.item.id), ["a1", "a2"])
assert.equal(multiple.queuePaused[targetKey], true)

// Same ID, different instructions: retain both payloads, pause instead of overwrite.
const conflict = { queues: { [oldKey]: [queued("same", "old text")], [targetKey]: [queued("same", "new text")] } }
reconcilePiQueueInstances(conflict, [session], history)
assert.equal(conflict.queues[targetKey][0].text, "new text")
assert.equal(conflict.piQueueRecovery[targetKey].conflictingItems[0].item.text, "old text")
assert.equal(piQueueNeedsConfirmation(conflict, targetKey), true)

// A duplicate waiting entry for an uncertain execution must never be replayed.
const duplicateActive = { queues: { [oldKey]: [queued("a1")] }, queueInFlight: { [oldKey]: active("a1") } }
reconcilePiQueueInstances(duplicateActive, [session], history)
assert.deepEqual(duplicateActive.queues[targetKey], [])
assert.equal(duplicateActive.piQueueRecovery[targetKey].uncertainItems.length, 1)

// Unique path evidence is mandatory; two files with the same ID are ambiguous.
for (const [sessions, entries, reason] of [
  [[{ ...session, sessionFile: null }], [], "missing-session-file"],
  [[session], [...history, { sessionId: id, sessionFile: "D:\\other\\chat.jsonl" }], "ambiguous-session-file"],
  [[session, { ...session, instanceId: "dddddddddddd" }], history, "multiple-live-instances"],
]) {
  const ambiguous = { queues: { [oldKey]: [queued("q")] } }
  const before = structuredClone(ambiguous)
  const report = reconcilePiQueueInstances(ambiguous, sessions, entries)
  assert.equal(report.changed, false)
  assert.equal(report.conflicts[0].reason, reason)
  assert.deepEqual(ambiguous, before)
}

// Closed catalog entries and still-live source processes are not remapped.
for (const sessions of [[{ ...session, status: "closed" }], [session, { ...session, instanceId: "aaaaaaaaaaaa" }]]) {
  const untouched = { queues: { [oldKey]: [queued("q")] } }
  const before = structuredClone(untouched)
  assert.equal(reconcilePiQueueInstances(untouched, sessions, history).changed, false)
  assert.deepEqual(untouched, before)
}

// Waiting-only migration preserves user pause/auto-start choice and needs no confirmation.
const waitingOnly = { queues: { [oldKey]: [queued("q")] }, queueStartOnIdle: { [oldKey]: true } }
reconcilePiQueueInstances(waitingOnly, [{ ...session, sessionFile: file.toUpperCase().replaceAll("\\", "/") }], history)
assert.equal(waitingOnly.queuePaused[targetKey], false)
assert.equal(waitingOnly.queueStartOnIdle[targetKey], true)
assert.equal(piQueueNeedsConfirmation(waitingOnly, targetKey), false)

// A subsequent process restart carries the confirmation records forward intact.
const next = { ...session, instanceId: "eeeeeeeeeeee" }
reconcilePiQueueInstances(multiple, [next], history)
const nextKey = `pi:eeeeeeeeeeee:${id}`
assert.equal(multiple.piQueueRecovery[targetKey], undefined)
assert.deepEqual(multiple.piQueueRecovery[nextKey].uncertainItems.map((entry) => entry.item.id), ["a1", "a2", "live"])
assert.equal(multiple.queueInFlight[nextKey], undefined)
assert.equal(multiple.queuePaused[nextKey], true)
console.log("PI_QUEUE_RECOVERY_TEST=PASS")
