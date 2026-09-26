import { createHash } from "node:crypto"
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createInterface } from "node:readline"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { listPiSessions } from "./pi-bridge.mjs"

const fileCache = new Map()
const readJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null } }
const keyFor = (path) => {
  try { return realpathSync.native(path).toLowerCase() }
  catch { return resolve(path).toLowerCase() }
}

export function piPromptText(content, limit = 120) {
  const value = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((part) => part?.type === "text").map((part) => part.text || "").join(" ") : ""
  return value.replace(/\s+/g, " ").trim().slice(0, limit)
}

export function piSessionTitle(session) {
  return session?.sessionName || session?.firstPrompt || basename(session?.directory || "") || session?.title || "Pi session"
}

async function readSessionFile(path, stats) {
  const key = keyFor(path)
  const cached = fileCache.get(key)
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.value
  const value = { sessionFile: path, id: "", directory: "", sessionName: "", firstPrompt: "" }
  const input = createReadStream(path, { encoding: "utf8" })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      let entry
      try { entry = JSON.parse(line) } catch { continue }
      if (entry?.type === "session") {
        value.id = String(entry.id || "")
        value.directory = String(entry.cwd || "")
      } else if (entry?.type === "session_info") {
        value.sessionName = String(entry.name || "")
      } else if (!value.firstPrompt && entry?.type === "message" && entry.message?.role === "user") {
        value.firstPrompt = piPromptText(entry.message.content)
      }
    }
  } finally { lines.close(); input.destroy() }
  fileCache.set(key, { size: stats.size, mtimeMs: stats.mtimeMs, value })
  return value
}

function sessionFiles(dataRoot, agentDir) {
  const files = new Map()
  const root = join(agentDir, "sessions")
  if (existsSync(root)) for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const directory = join(root, project.name)
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) {
        const path = join(directory, file.name)
        files.set(keyFor(path), path)
      }
    }
  }
  const history = join(dataRoot, "pi", "history")
  if (existsSync(history)) for (const file of readdirSync(history)) {
    if (!/^[a-f0-9]{24}\.json$/.test(file)) continue
    const path = readJson(join(history, file))?.sessionFile
    if (typeof path === "string" && existsSync(path)) files.set(keyFor(path), path)
  }
  return [...files.values()]
}

export async function listPiCatalog(dataRoot, { agentDir = join(homedir(), ".pi", "agent"), now = Date.now() } = {}) {
  const live = listPiSessions(dataRoot, now)
  const liveFiles = new Map(live.filter((item) => item.sessionFile).map((item) => [keyFor(item.sessionFile), true]))
  const saved = []
  for (const path of sessionFiles(dataRoot, agentDir)) {
    let stats
    try { stats = statSync(path) } catch { continue }
    if (!stats.isFile()) continue
    let item
    try { item = await readSessionFile(path, stats) } catch { continue }
    if (!item.id || !item.directory) continue
    if (liveFiles.has(keyFor(path))) {
      for (const instance of live) if (instance.sessionFile && keyFor(instance.sessionFile) === keyFor(path)) {
        instance.sessionName = item.sessionName || instance.sessionName || ""
        instance.firstPrompt = item.firstPrompt || instance.firstPrompt || ""
        instance.title = piSessionTitle(instance)
      }
      continue
    }
    const session = { backend: "pi", id: item.id, instanceId: createHash("sha256").update(keyFor(path)).digest("hex").slice(0, 12),
      sessionFile: path, directory: item.directory, sessionName: item.sessionName,
      firstPrompt: item.firstPrompt, title: "", status: "closed", updatedAt: stats.mtimeMs }
    session.title = piSessionTitle(session)
    saved.push(session)
  }
  for (const instance of live) instance.title = piSessionTitle(instance)
  return [...live, ...saved].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}
