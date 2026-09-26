import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null } }

export function listPiSessions(dataRoot, now = Date.now()) {
  const root = join(dataRoot, "pi", "instances")
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => /^[a-f0-9]{12}\.json$/.test(name)).map((name) => readJson(join(root, name)))
    .filter((item) => item?.instanceId && item?.sessionId && now - Date.parse(item.updatedAt || 0) < 20000)
    .map((item) => ({ id: item.sessionId, backend: "pi", instanceId: item.instanceId,
      title: item.title || "Pi session", directory: item.directory || "", status: item.status || "idle",
      sessionFile: item.sessionFile || null,
      updatedAt: Date.parse(item.updatedAt), dashboardStartedAt: item.startedAt ? Date.parse(item.startedAt) : 0,
      model: item.model || null, thinkingLevel: item.thinkingLevel || null,
      latestReply: item.latestReply || "", lastError: item.lastError || null,
      lastFinishedAt: item.lastFinishedAt || null, lastRunId: item.lastRunId || null }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function findPiHistory(dataRoot, sessionId) {
  const directory = join(dataRoot, "pi", "history")
  if (!existsSync(directory)) return null
  return readdirSync(directory).filter((name) => /^[a-f0-9]{24}\.json$/.test(name))
    .map((name) => readJson(join(directory, name)))
    .filter((item) => item?.sessionId === sessionId && item?.sessionFile && existsSync(item.sessionFile))
    .sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))[0] || null
}

export function piResumeCommand(session) {
  if (!session?.directory || !session?.sessionFile || !existsSync(session.sessionFile)) return null
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  const pi = join(homedir(), ".pi", "agent", "bin", "pi.cmd")
  return `Set-Location -LiteralPath ${quote(session.directory)}\n& ${quote(pi)} --session ${quote(session.sessionFile)}`
}

export async function sendPiCommand(dataRoot, session, type, text = "", { timeoutMs = 8000 } = {}) {
  const live = listPiSessions(dataRoot).find((item) => item.id === session.id && item.instanceId === session.instanceId)
  if (!live) throw new Error("Pi terminal session is offline or has switched sessions")
  const id = randomUUID()
  const inbox = join(dataRoot, "pi", "inbox", session.instanceId)
  const replies = join(dataRoot, "pi", "replies", session.instanceId)
  mkdirSync(inbox, { recursive: true })
  mkdirSync(replies, { recursive: true })
  const path = join(inbox, `${id}.json`)
  writeFileSync(path, JSON.stringify({ id, type, sessionId: session.id, text, createdAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx", mode: 0o600 })
  const replyPath = join(replies, `${id}.json`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const reply = readJson(replyPath)
    if (reply) {
      rmSync(replyPath, { force: true })
      if (!reply.ok) throw new Error(reply.error || "Pi command rejected")
      return reply
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const error = new Error("Pi terminal did not acknowledge the command; delivery is uncertain")
  error.code = "PI_ACK_UNCERTAIN"
  throw error
}
