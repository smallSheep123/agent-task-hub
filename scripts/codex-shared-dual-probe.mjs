import { CodexAppServer } from "../adapters/codex-app-server.mjs"

const wsUrl = process.env.AGENT_TASK_HUB_CODEX_WS_URL || "ws://127.0.0.1:9234"
const options = {
  transport: "shared",
  wsUrl,
  requestTimeoutMs: 10000,
  sharedConnectTimeoutMs: 10000,
}
const first = new CodexAppServer(options)
const second = new CodexAppServer(options)

try {
  await Promise.all([first.start(), second.start()])
  const sessions = await first.listSessions({ limit: 100 })
  let selected = null
  let lastError = null
  for (const session of [...sessions].reverse()) {
    if (session.status === "busy") continue
    try {
      await first.resumeThread(session.id)
      await second.resumeThread(session.id)
      selected = session
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!selected) throw lastError || new Error("No idle Codex task was available for a dual-client probe")
  console.log(`CODEX_SHARED_DUAL_PROBE=PASS THREAD=${selected.id} TITLE=${JSON.stringify(selected.title)}`)
} catch (error) {
  console.error(`CODEX_SHARED_DUAL_PROBE=FAIL ${error.message}`)
  process.exitCode = 1
} finally {
  await Promise.allSettled([first.stop(), second.stop()])
}

setTimeout(() => process.exit(process.exitCode || 0), 25)
