import assert from "node:assert/strict"
import { resolveZCodeBundle, zcodeSessionToHubSession, zcodeTerminalEvent } from "../adapters/zcode-app-server.mjs"

const session = zcodeSessionToHubSession({
  sessionId: "sess_1",
  title: "Fix the build",
  workspace: { workspacePath: "C:\\work", workspaceKey: "local:test" },
  status: "running",
  model: { providerId: "account:test", modelId: "GLM-5.3", options: { reasoningLevel: "high" } },
  createdAt: 1700000000000,
  updatedAt: 1700000010000,
})
assert.equal(session.backend, "zcode")
assert.equal(session.status, "busy")
assert.equal(session.directory, "C:\\work")
assert.equal(session.model.modelId, "GLM-5.3")

const completed = zcodeTerminalEvent({
  eventId: "event_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  type: "turn.completed",
  timestamp: 1700000020000,
  payload: { response: "Done", resultType: "success", duration: 1200 },
}, { sessionId: "sess_1", title: "Fix the build", workspace: { workspacePath: "C:\\work" } })
assert.equal(completed.type, "session.idle")
assert.equal(completed.excerpt, "Done")
assert.equal(completed.durationMs, 1200)

const cancelled = zcodeTerminalEvent({ eventId: "event_2", sessionId: "sess_1", type: "turn.completed", payload: { resultType: "cancelled" } })
assert.equal(cancelled.type, "session.interrupted")
const failed = zcodeTerminalEvent({ eventId: "event_3", sessionId: "sess_1", type: "turn.failed", payload: { error: { message: "boom" } } })
assert.equal(failed.type, "session.error")
assert.equal(failed.error, "boom")

assert.equal(typeof resolveZCodeBundle, "function")
if (process.env.AGENT_TASK_HUB_TEST_ZCODE_BUNDLE) assert.equal(typeof resolveZCodeBundle(process.env.AGENT_TASK_HUB_TEST_ZCODE_BUNDLE), "string")
console.log("ZCODE_ADAPTER_TEST=PASS")
