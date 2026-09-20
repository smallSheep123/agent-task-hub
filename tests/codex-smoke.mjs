import { CodexAppServer } from "../adapters/codex-app-server.mjs"

const client = new CodexAppServer({ requestTimeoutMs: 30000 })
try {
  await client.start()
  const sessions = await client.listSessions({ limit: 5 })
  const thread = sessions[0] ? await client.readThread(sessions[0].id) : null
  let terminals = 0
  client.on("terminal", () => { terminals += 1 })
  await client.startMonitor({ intervalMs: 2000, limit: 20 })
  await new Promise((resolve) => setTimeout(resolve, 2200))
  console.log("CODEX_SMOKE=PASS SESSIONS=" + sessions.length + " READ=" + Boolean(!sessions[0] || thread?.id === sessions[0].id) + " BASELINE_EVENTS=" + terminals)
} finally {
  await client.stop()
}
