import assert from "node:assert/strict"
import { codexTaskStartedAt, isRunningStatus, openCodeTaskStartedAt, pendingBreakdown, timestampMilliseconds } from "../app/dashboard.mjs"

assert.equal(timestampMilliseconds(1700000000), 1700000000000)
assert.equal(timestampMilliseconds(1700000000000), 1700000000000)
assert.equal(timestampMilliseconds(null), 0)
assert.equal(isRunningStatus("busy"), true)
assert.equal(isRunningStatus({ type: "inProgress" }), true)
assert.equal(isRunningStatus("retry"), true)
assert.equal(isRunningStatus("idle"), false)
assert.equal(isRunningStatus("error"), false)

const messages = [
  { info: { role: "user", time: { created: 1700000000000 } } },
  { info: { role: "assistant", time: { created: 1700000001000, completed: 1700000010000 } } },
  { info: { role: "user", time: { created: 1700000020000 } } },
  { info: { role: "assistant", time: { created: 1700000021000 } } },
  { info: { role: "user", time: { created: 1700000030000 } } },
]
assert.equal(openCodeTaskStartedAt(messages), 1700000020000)
assert.equal(openCodeTaskStartedAt([]), 0)
assert.equal(codexTaskStartedAt({ turns: [{ status: "completed", startedAt: 1700000000 }, { status: "inProgress", startedAt: 1700000100 }] }), 1700000100000)
assert.equal(codexTaskStartedAt({ turns: [{ status: "interrupted", startedAt: 1700000200, completedAt: null }] }), 1700000200000)
assert.equal(codexTaskStartedAt({ turns: [] }), 0)
assert.deepEqual(pendingBreakdown({ approvals: 2, questions: 1 }), { approvals: 2, questions: 1 })

console.log("DASHBOARD_TEST=PASS")
