import assert from "node:assert/strict"
import {
  CodexAppServer,
  approvalOptionsForRequest,
  approvalResponseForRequest,
  codexMonitorBackoffMs,
  codexThreadToSession,
  externalTerminalTurn,
  isUserFacingCodexThread,
  terminalEventFromNotification,
} from "../adapters/codex-app-server.mjs"

assert.equal(codexMonitorBackoffMs(5000, 0), 5000)
assert.equal(codexMonitorBackoffMs(5000, 1), 10000)
assert.equal(codexMonitorBackoffMs(60000, 4), 900000)
assert.equal(codexMonitorBackoffMs(60000, 20), 900000)

assert.equal(isUserFacingCodexThread({ source: "vscode", preview: "User task" }), true)
assert.equal(isUserFacingCodexThread({ source: "appServer", preview: "Hub task" }), true)
assert.equal(isUserFacingCodexThread({ source: { subAgent: { other: "guardian" } }, preview: "Internal" }), false)
assert.equal(isUserFacingCodexThread({ sourceKind: "subAgentReview", preview: "Internal" }), false)
assert.equal(isUserFacingCodexThread({ preview: "The following is the Codex agent history whose request action you are assessing. Treat this as evidence." }), false)

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

const persistedWhileRunning = {
  turns: [
    { id: "turn_old", status: "completed", completedAt: 1700000000 },
    { id: "turn_current", status: "interrupted", startedAt: 1700000100, completedAt: null },
  ],
}
assert.equal(externalTerminalTurn(persistedWhileRunning), null)
assert.equal(externalTerminalTurn({
  turns: [
    { id: "turn_old", status: "completed", completedAt: 1700000000 },
    { id: "turn_current", status: "inProgress", startedAt: 1700000100 },
  ],
}), null)
const finalExternalTurn = { id: "turn_current", status: "completed", completedAt: 1700000120 }
assert.equal(externalTerminalTurn({ turns: [finalExternalTurn] }), finalExternalTurn)
assert.equal(externalTerminalTurn({ turns: [finalExternalTurn] }, { observedTurns: new Set(["turn_current"]) }), null)

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

const recoveryClient = new CodexAppServer({ requestTimeoutMs: 20000 })
let finishResume
const resumeCalls = []
recoveryClient.request = (method, params, budget) => {
  resumeCalls.push({ method, params, budget })
  return new Promise((resolve) => { finishResume = resolve })
}
const firstResume = recoveryClient.resumeThread("large_history")
const secondResume = recoveryClient.resumeThread("large_history")
assert.equal(resumeCalls.length, 1, "concurrent callers must share one resume request")
assert.equal(resumeCalls[0].budget, 60000)
finishResume({ thread: { id: "large_history", turns: [] } })
await Promise.all([firstResume, secondResume])
assert.equal(recoveryClient.loadedThreads.has("large_history"), true)
assert.equal(recoveryClient.resumingThreads.size, 0)
recoveryClient.request = async () => { throw new Error("resume timed out") }
await assert.rejects(recoveryClient.sendPrompt("not_loaded", "do not retry"), /resume timed out/)
assert.equal(recoveryClient.resumingThreads.size, 0)
assert.equal(recoveryClient.loadedThreads.has("not_loaded"), false)
const desktopClient = new CodexAppServer()
desktopClient.transport = "shared-websocket"
const desktopMethods = []
desktopClient.request = async (method) => {
  desktopMethods.push(method)
  return { thread: { id: "desktop_busy", turns: [{ id: "active_turn", status: "inProgress" }] } }
}
await assert.rejects(desktopClient.sendPrompt("desktop_busy", "queue this"), (error) => error.code === "CODEX_TURN_ACTIVE")
assert.deepEqual(desktopMethods, ["thread/read"], "Desktop busy detection must not resume or send another turn")

const previousObserver = new CodexAppServer()
const beforeDisconnect = Date.now() - 60000
previousObserver.monitorStartedAt = beforeDisconnect
previousObserver.monitorInitialized = true
previousObserver.threadVersions.set("external-desktop", beforeDisconnect)
previousObserver.observedTurns.add("already-notified")
const afterReconnect = new CodexAppServer()
afterReconnect.importMonitorState(previousObserver.exportMonitorState())
afterReconnect.ready = true
const completedAt = Date.now() - 1000
const duringDisconnect = { id: "finished-offline", status: "completed", startedAt: beforeDisconnect + 1000, completedAt, items: [{ type: "agentMessage", text: "done while disconnected" }] }
afterReconnect.request = async (method) => method === "thread/list"
  ? { data: [{ id: "external-desktop", source: "vscode", updatedAt: completedAt }] }
  : { thread: { id: "external-desktop", source: "vscode", turns: [duringDisconnect] } }
const replayed = []
afterReconnect.on("terminal", (event) => replayed.push(event))
await afterReconnect.startMonitor()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(afterReconnect.monitorStartedAt, beforeDisconnect)
assert.equal(replayed.length, 1, "the first reconnected scan must reconcile work completed during disconnect")
assert.equal(replayed[0].turnId, "finished-offline")
assert.equal(afterReconnect.exportMonitorState().observedTurns.includes("already-notified"), true)
await afterReconnect.stop()
const anotherReconnect = new CodexAppServer()
anotherReconnect.importMonitorState(afterReconnect.exportMonitorState())
anotherReconnect.ready = true
anotherReconnect.request = afterReconnect.request
anotherReconnect.on("terminal", (event) => replayed.push(event))
await anotherReconnect.startMonitor()
await new Promise((resolve) => setImmediate(resolve))
assert.equal(replayed.length, 1, "another reconnect must not duplicate the completion")
await anotherReconnect.stop()
console.log("CODEX_ADAPTER_TEST=PASS")
