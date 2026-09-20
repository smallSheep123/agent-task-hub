import assert from "node:assert/strict"
import { createServer } from "node:http"
import {
  chooseOpenCodeQuestionOption,
  completeOpenCodeQuestion,
  nextOpenCodeQuestionIndex,
  normalizeOpenCodeQuestion,
  openCodeQuestionAnswers,
  openCodeQuestionToken,
  submitOpenCodeQuestion,
} from "../adapters/opencode-question.mjs"

const normalized = normalizeOpenCodeQuestion({
  id: "que_123",
  sessionID: "ses_123",
  questions: [
    { header: "Action", question: "Continue?", options: [{ label: "Fix", description: "Apply the fix" }], multiple: false, custom: true },
    { header: "Checks", question: "Which checks?", options: [{ label: "Unit", description: "Unit tests" }, { label: "E2E", description: "End-to-end tests" }], multiple: true, custom: false },
  ],
})
assert.equal(normalized.requestId, "que_123")
assert.equal(normalized.questions.length, 2)
assert.equal(normalizeOpenCodeQuestion({ id: "bad" }), null)

const request = { ...normalized, answers: {}, completedQuestions: {} }
assert.equal(nextOpenCodeQuestionIndex(request), 0)
assert.equal(chooseOpenCodeQuestionOption(request, 0, "Fix"), true)
assert.equal(nextOpenCodeQuestionIndex(request), 1)
assert.equal(chooseOpenCodeQuestionOption(request, 1, "Unit"), false)
assert.equal(chooseOpenCodeQuestionOption(request, 1, "E2E"), false)
assert.equal(chooseOpenCodeQuestionOption(request, 1, "Unit"), false)
assert.deepEqual(request.answers[1], ["E2E"])
completeOpenCodeQuestion(request, 1)
assert.deepEqual(openCodeQuestionAnswers(request), [["Fix"], ["E2E"]])

const custom = { ...normalized, answers: {}, completedQuestions: {} }
completeOpenCodeQuestion(custom, 0, "Investigate pagination first")
assert.deepEqual(custom.answers[0], ["Investigate pagination first"])
assert.equal(nextOpenCodeQuestionIndex(custom), 1)

const token = openCodeQuestionToken("http://127.0.0.1:4096", "que_123")
assert.match(token, /^[0-9a-f]{16}$/)
assert.equal(token, openCodeQuestionToken("http://127.0.0.1:4096", "que_123"))
assert.ok(Buffer.byteLength(`oqa:${token}:19:19`, "utf8") <= 64)
assert.ok(Buffer.byteLength(`oqs:${token}:19`, "utf8") <= 64)

const received = []
const server = createServer((request, response) => {
  let body = ""
  request.setEncoding("utf8")
  request.on("data", (chunk) => { body += chunk })
  request.on("end", () => {
    received.push({ url: request.url, method: request.method, body, authorization: request.headers.authorization })
    response.writeHead(200, { "content-type": "application/json" })
    response.end("true")
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
try {
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  assert.equal(await submitOpenCodeQuestion({ serverUrl: base, directory: "D:\\Project Folder", requestId: "que_123", action: "reply", answers: [["Fix"], ["E2E"]], headers: { authorization: "Basic test" } }), true)
  assert.equal(await submitOpenCodeQuestion({ serverUrl: base, directory: "D:\\Project Folder", requestId: "que_456", action: "reject" }), true)
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
assert.equal(received.length, 2)
assert.match(received[0].url, /^\/question\/que_123\/reply\?directory=/)
assert.equal(received[0].method, "POST")
assert.equal(received[0].authorization, "Basic test")
assert.deepEqual(JSON.parse(received[0].body), { answers: [["Fix"], ["E2E"]] })
assert.equal(received[1].body, "")
await assert.rejects(() => submitOpenCodeQuestion({ serverUrl: "https://example.com", requestId: "que_x", action: "reply", answers: [[]] }), /Remote OpenCode/)
await assert.rejects(() => submitOpenCodeQuestion({ serverUrl: "http://127.0.0.1:1", requestId: "que_x", action: "delete" }), /Unsupported/)

console.log("OPENCODE_QUESTION_TEST=PASS")
