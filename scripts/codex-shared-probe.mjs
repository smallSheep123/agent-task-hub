import { CodexAppServer } from "../adapters/codex-app-server.mjs"

const client = new CodexAppServer({
  command: process.env.AGENT_TASK_HUB_CODEX_COMMAND || "codex",
  transport: "shared",
  wsUrl: process.env.AGENT_TASK_HUB_CODEX_WS_URL || "",
  requestTimeoutMs: 10000,
  sharedConnectTimeoutMs: 10000,
})

client.on("diagnostic", (message) => {
  if (message) process.stderr.write(`[codex] ${message}\n`)
})

try {
  await client.start()
  const sessions = await client.listSessions({ limit: 1 })
  console.log(`CODEX_SHARED_PROBE=PASS TRANSPORT=${client.transport} SESSIONS_READ=${sessions.length}`)
} catch (error) {
  console.error(`CODEX_SHARED_PROBE=FAIL ${error.message}`)
  process.exitCode = 1
} finally {
  await client.stop().catch(() => {})
}

setTimeout(() => process.exit(process.exitCode || 0), 25)
