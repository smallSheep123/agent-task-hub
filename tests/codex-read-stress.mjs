import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { CodexAppServer } from "../adapters/codex-app-server.mjs"

const client = new CodexAppServer({ requestTimeoutMs: 30000 })
const percentile = (values, fraction) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))]

try {
  await client.start()
  const listTimes = []
  const batches = await Promise.all(Array.from({ length: 20 }, async () => {
    const started = performance.now()
    const sessions = await client.listSessions({ limit: 100 })
    listTimes.push(performance.now() - started)
    return sessions
  }))
  assert.ok(batches.every((sessions) => Array.isArray(sessions)))
  const expectedIds = batches[0].map((session) => session.id)
  for (const sessions of batches.slice(1)) assert.deepEqual(sessions.map((session) => session.id), expectedIds)

  const targets = batches[0].slice(0, 20)
  const readTimes = []
  await Promise.all(targets.map(async (session) => {
    const started = performance.now()
    const thread = await client.readThread(session.id)
    readTimes.push(performance.now() - started)
    assert.equal(thread?.id, session.id)
  }))

  console.log("CODEX_READ_STRESS=PASS " + JSON.stringify({
    concurrentLists: batches.length,
    sessionsPerList: expectedIds.length,
    concurrentReads: targets.length,
    listP50Ms: Math.round(percentile(listTimes, 0.5)),
    listP95Ms: Math.round(percentile(listTimes, 0.95)),
    readP50Ms: Math.round(percentile(readTimes, 0.5)),
    readP95Ms: Math.round(percentile(readTimes, 0.95)),
  }))
} finally {
  await client.stop().catch(() => {})
}
