import assert from "node:assert/strict"
import {
  approvalOptionsForRequest,
  approvalResponseForRequest,
  codexThreadToSession,
  terminalEventFromNotification,
} from "../adapters/codex-app-server.mjs"

const session = codexThreadToSession({
  id: "thr_1",
  name: "Fix tests",
  cwd: "C:\\work",
  status: { type: "active", activeFlags: [] },
  turns: [],
})
assert.equal(session.backend, "codex")
assert.equal(session.status, "busy")
assert.equal(session.title, "Fix tests")

const completion = terminalEventFromNotification({
  threadId: "thr_1",
  turn: {
    id: "turn_1",
    status: "completed",
    durationMs: 1200,
    items: [
      { type: "fileChange", changes: [{ path: "a.js", diff: "@@\n-old\n+new" }] },
      { type: "agentMessage", text: "All tests pass." },
    ],
  },
}, { id: "thr_1", name: "Fix tests", cwd: "C:\\work" })
assert.equal(completion.id, "codex:thr_1:turn_1")
assert.equal(completion.type, "session.idle")
assert.equal(completion.excerpt, "All tests pass.")
assert.deepEqual(completion.summary, { files: 1, additions: 1, deletions: 1 })

const interrupted = terminalEventFromNotification({
  threadId: "thr_1",
  turn: { id: "turn_2", status: "interrupted", items: [] },
})
assert.equal(interrupted.type, "session.interrupted")

assert.deepEqual(
  approvalOptionsForRequest("item/commandExecution/requestApproval", { availableDecisions: ["accept", "decline"] }).map((item) => item.action),
  ["accept", "decline"],
)
assert.deepEqual(
  approvalResponseForRequest("item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, "session"),
  { permissions: { network: { enabled: true } }, scope: "session" },
)
assert.deepEqual(
  approvalResponseForRequest("item/fileChange/requestApproval", {}, "accept"),
  { decision: "accept" },
)

console.log("CODEX_ADAPTER_TEST=PASS")
