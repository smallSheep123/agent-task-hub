import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findPiHistory, listPiSessions, piResumeCommand, sendPiCommand } from "../adapters/pi-bridge.mjs"
import { decodeSessionAction, encodeSessionAction } from "../app/agent-context.mjs"

const root = mkdtempSync(join(tmpdir(), "agent-hub-pi-"))
process.env.AGENT_TASK_HUB_DATA_DIR = root
const handlers = new Map()
const sent = []
const sessionId = "12345678-1234-1234-1234-123456789abc"
const sessionFile = join(root, "saved.jsonl")
writeFileSync(sessionFile, '{}\n')
const context = {
  cwd: "C:\\test", model: { provider: "test", id: "model" }, thinkingLevel: "low",
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getSessionName: () => "Pi test" },
  abort: () => { sent.push("abort") },
}
try {
  const extension = (await import("../adapters/pi-extension.js")).default
  extension({ on: (name, handler) => { handlers.set(name, handler) }, sendUserMessage: async (value) => { sent.push(value) } })
  await handlers.get("session_start")({}, context)
  const [session] = listPiSessions(root)
  assert.equal(session.id, sessionId)
  assert.equal(session.status, "idle")
  assert.equal(session.sessionFile, sessionFile)
  assert.equal(findPiHistory(root, sessionId)?.sessionFile, sessionFile)
  assert.match(piResumeCommand(session), /--session/)
  assert.deepEqual(decodeSessionAction(encodeSessionAction("select", session), "select"), { backend: "pi", instanceId: session.instanceId, id: sessionId })
  assert.equal((await sendPiCommand(root, session, "send", "hello")).ok, true)
  assert.deepEqual(sent, ["hello"])
  await handlers.get("agent_start")({}, context)
  assert.equal(listPiSessions(root)[0].status, "busy")
  await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }, context)
  await handlers.get("agent_settled")({}, context)
  assert.equal(listPiSessions(root)[0].status, "idle")
  const eventFile = readdirSync(join(root, "events"))[0]
  const event = JSON.parse(readFileSync(join(root, "events", eventFile), "utf8"))
  assert.equal(event.backend, "pi")
  assert.equal(event.excerpt, "done")
  assert.equal(event.instanceId, session.instanceId)
  assert.equal((await sendPiCommand(root, session, "abort")).ok, true)
  assert.equal(sent.at(-1), "abort")
  await handlers.get("session_shutdown")()
  assert.equal(listPiSessions(root).length, 0)
  assert.equal(findPiHistory(root, sessionId)?.sessionFile, sessionFile)
  console.log("PI_BRIDGE_TEST=PASS")
} finally {
  rmSync(root, { recursive: true, force: true })
}
