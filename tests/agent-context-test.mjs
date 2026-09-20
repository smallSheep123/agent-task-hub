import assert from "node:assert/strict"
import {
  decodeSessionAction,
  encodeSessionAction,
  enterAgentMode,
  enterGlobalMode,
  filterAgentSessions,
  initializeAgentContext,
  migrateSessionCollections,
  selectAgentSession,
  sessionIdentity,
} from "../app/agent-context.mjs"

const migrated = initializeAgentContext({ selected: { id: "old-session" } })
assert.equal(migrated.selected.backend, "opencode")
assert.equal(migrated.viewMode, "agent")
assert.equal(migrated.activeBackend, "opencode")

enterAgentMode(migrated, "codex")
assert.equal(migrated.viewMode, "agent")
assert.equal(migrated.activeBackend, "codex")

selectAgentSession(migrated, { id: "ses-1", backend: "opencode", serverUrl: "http://127.0.0.1:4096" })
assert.equal(migrated.activeBackend, "opencode")
assert.equal(migrated.selected.backend, "opencode")

enterGlobalMode(migrated)
assert.equal(migrated.viewMode, "global")
assert.equal(migrated.activeBackend, null)

const sessions = [{ id: "o", backend: "opencode" }, { id: "c", backend: "codex" }]
assert.deepEqual(filterAgentSessions(sessions, "codex").map((item) => item.id), ["c"])
assert.equal(filterAgentSessions(sessions, "all").length, 2)
assert.match(sessionIdentity(sessions[0]), /^opencode:/)
assert.equal(sessionIdentity({ backend: "opencode", instanceId: "ignored", serverUrl: "http://127.0.0.1:4096", sessionId: "abc" }), "opencode:http://127.0.0.1:4096:abc")
assert.equal(encodeSessionAction("select", { backend: "codex", id: "abc" }), "select:c:abc")
assert.deepEqual(decodeSessionAction("select:c:abc", "select"), { backend: "codex", id: "abc" })
assert.deepEqual(decodeSessionAction("select:legacy", "select"), { backend: "opencode", id: "legacy" })
assert.equal(decodeSessionAction("show:o:abc", "select"), null)
const oldState = { queues: { abc: [{ id: "q1" }] }, queuePaused: { abc: true }, recentEvents: {} }
const migratedKey = migrateSessionCollections(oldState, { backend: "opencode", serverUrl: "http://127.0.0.1:4096", id: "abc" })
assert.equal(migratedKey, "opencode:http://127.0.0.1:4096:abc")
assert.deepEqual(oldState.queues[migratedKey], [{ id: "q1" }])
assert.equal(oldState.queues.abc, undefined)
assert.equal(oldState.queuePaused[migratedKey], true)
assert.throws(() => enterAgentMode({}, "unknown"))

console.log("AGENT_CONTEXT_TEST=PASS")
