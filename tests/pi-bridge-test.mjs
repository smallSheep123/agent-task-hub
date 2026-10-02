import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findPiHistory, listPiSessions, piResumeCommand, sendPiCommand } from "../adapters/pi-bridge.mjs"
import { latestPiReply, listPiCatalog, piSessionTitle } from "../adapters/pi-catalog.mjs"
import { decodeSessionAction, encodeSessionAction } from "../app/agent-context.mjs"

const root = mkdtempSync(join(tmpdir(), "agent-hub-pi-"))
process.env.AGENT_TASK_HUB_DATA_DIR = root
const handlers = new Map()
const sent = []
const sessionId = "12345678-1234-1234-1234-123456789abc"
const sessionFile = join(root, "saved.jsonl")
writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId, cwd: "C:\\test", timestamp: new Date().toISOString() })}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Inspect the first failure\nand explain it" }] } })}\n${JSON.stringify({ type: "session_info", name: "Named work" })}\n`)
const context = {
  cwd: "C:\\test", model: { provider: "test", id: "model" }, thinkingLevel: "low",
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getSessionName: () => "Pi test" },
  abort: () => { sent.push("abort") },
}
try {
  const { atomicJson, default: extension } = await import("../adapters/pi-extension.js")
  const atomicPath = join(root, "retry.json")
  let attempts = 0
  atomicJson(atomicPath, { saved: true }, {
    renameFile: (source, destination) => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error("Windows file busy"), { code: "EPERM" })
      renameSync(source, destination)
    },
    wait: () => {},
  })
  assert.equal(attempts, 3)
  assert.deepEqual(JSON.parse(readFileSync(atomicPath, "utf8")), { saved: true })
  assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0)
  assert.throws(() => atomicJson(atomicPath, { saved: false }, {
    renameFile: () => { throw Object.assign(new Error("Windows file busy"), { code: "EPERM" }) },
    wait: () => {},
  }), { code: "EPERM" })
  assert.deepEqual(JSON.parse(readFileSync(atomicPath, "utf8")), { saved: true })
  assert.equal(readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0)
  extension({ on: (name, handler) => { handlers.set(name, handler) }, sendUserMessage: async (value) => { sent.push(value) } })
  await handlers.get("session_start")({}, context)
  const [session] = listPiSessions(root)
  assert.equal(session.id, sessionId)
  assert.equal(session.status, "idle")
  assert.equal(session.sessionFile, sessionFile)
  assert.equal(findPiHistory(root, sessionId)?.sessionFile, sessionFile)
  const [liveCatalog] = await listPiCatalog(root, { agentDir: join(root, "empty-agent") })
  assert.equal(liveCatalog.firstPrompt, "Inspect the first failure and explain it")
  assert.equal(piSessionTitle(liveCatalog), "Named work")
  assert.match(piResumeCommand(session), /--session/)
  assert.deepEqual(decodeSessionAction(encodeSessionAction("select", session), "select"), { backend: "pi", instanceId: session.instanceId, id: sessionId })
  assert.ok(Buffer.byteLength(encodeSessionAction("sendhelp", session), "utf8") <= 64)
  assert.equal((await sendPiCommand(root, session, "send", "hello")).ok, true)
  assert.deepEqual(sent, ["hello"])
  assert.equal(readdirSync(join(root, "pi", "inbox", session.instanceId)).some((name) => name.endsWith(".tmp")), false)
  // Simulate a legacy writer exposing a partial command. A poll must not delete it.
  const partialId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
  const partialPath = join(root, "pi", "inbox", session.instanceId, `${partialId}.json`)
  writeFileSync(partialPath, '{"type":"send",')
  await new Promise((resolve) => setTimeout(resolve, 850))
  assert.equal(existsSync(partialPath), true)
  assert.deepEqual(sent, ["hello"])
  writeFileSync(partialPath, JSON.stringify({ id: partialId, type: "send", sessionId, text: "recovered partial command" }))
  await new Promise((resolve) => setTimeout(resolve, 850))
  assert.deepEqual(sent, ["hello", "recovered partial command"])
  assert.equal(existsSync(partialPath), false)
  await handlers.get("agent_start")({}, context)
  assert.equal(listPiSessions(root)[0].status, "busy")
  const fullReply = `done\n${"中文完整回复。".repeat(400)}`
  appendFileSync(sessionFile, `${JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: fullReply }] } })}\n`)
  await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: fullReply }] } }, context)
  await handlers.get("agent_settled")({}, context)
  assert.equal(listPiSessions(root)[0].status, "idle")
  const eventFile = readdirSync(join(root, "events"))[0]
  const event = JSON.parse(readFileSync(join(root, "events", eventFile), "utf8"))
  assert.equal(event.backend, "pi")
  assert.equal(event.excerpt, fullReply)
  assert.equal((await latestPiReply(sessionFile)).text, fullReply)
  assert.equal(event.instanceId, session.instanceId)
  // Use one run deliberately: the final assistant outcome supersedes an earlier
  // assistant failure, independent of whether the host emits agent_start on retries.
  await handlers.get("agent_start")({}, context)
  await handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "temporary failure", content: [] } }, context)
  await handlers.get("message_end")({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered successfully" }] } }, context)
  await handlers.get("agent_settled")({}, context)
  const outcomes = () => readdirSync(join(root, "events")).map((name) => JSON.parse(readFileSync(join(root, "events", name), "utf8")))
  const recovered = outcomes().find((item) => item.excerpt === "recovered successfully")
  assert.equal(recovered.type, "session.idle")
  assert.equal(recovered.error, null)
  assert.equal(listPiSessions(root)[0].lastError, null)
  await handlers.get("agent_start")({}, context)
  await handlers.get("message_end")({ message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "partial work" }] } }, context)
  await handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "final failure", content: [] } }, context)
  await handlers.get("agent_settled")({}, context)
  assert.equal(outcomes().find((item) => item.error === "final failure").type, "session.error")
  assert.equal((await sendPiCommand(root, session, "abort")).ok, true)
  assert.equal(sent.at(-1), "abort")
  await handlers.get("session_shutdown")()
  assert.equal(listPiSessions(root).length, 0)
  assert.equal(findPiHistory(root, sessionId)?.sessionFile, sessionFile)
  const [savedCatalog] = await listPiCatalog(root, { agentDir: join(root, "empty-agent") })
  assert.equal(savedCatalog.status, "closed")
  assert.equal(savedCatalog.firstPrompt, "Inspect the first failure and explain it")
  console.log("PI_BRIDGE_TEST=PASS")
} finally {
  rmSync(root, { recursive: true, force: true })
}
