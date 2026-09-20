import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const dataRoot = process.env.AGENT_TASK_HUB_DATA_DIR || join(homedir(), ".config", "agent-task-hub")
const instancesDir = join(dataRoot, "instances")
const eventsDir = join(dataRoot, "events")
const configPath = join(dataRoot, "config.json")

async function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
  try {
    await rename(temp, path)
  } catch (error) {
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    await rm(path, { force: true }).catch(() => {})
    try {
      await rename(temp, path)
    } catch (retryError) {
      await rm(temp, { force: true }).catch(() => {})
      throw retryError
    }
  }
}

function loopbackServer(value) {
  const url = new URL(String(value))
  const host = url.hostname.toLowerCase()
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Agent Task Hub accepts loopback OpenCode servers only")
  }
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

async function configured() {
  try {
    await access(configPath)
    return true
  } catch {
    return false
  }
}

function unwrap(result) {
  return result && typeof result === "object" && "data" in result ? result.data : result
}

function lastAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i]
    if (message?.info?.role !== "assistant") continue
    const text = (message.parts || [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n")
    if (text) return text.slice(0, 1800)
  }
  return ""
}

function protectForCurrentUser(value) {
  if (!value) return null
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key]
  const script = "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$plain=[Console]::In.ReadToEnd();$bytes=[Text.Encoding]::UTF8.GetBytes($plain);$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($protected))"
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: value,
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 45000,
  })
  if (result.status !== 0) throw new Error(`Unable to protect OpenCode local credential: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`)
  return result.stdout.trim() || null
}

export const TelegramBridgePlugin = async ({ client, directory, serverUrl }) => {
  await mkdir(instancesDir, { recursive: true, mode: 0o700 })
  await mkdir(eventsDir, { recursive: true, mode: 0o700 })

  let localServer
  try {
    localServer = loopbackServer(serverUrl)
  } catch {
    return { event: async () => {} }
  }

  const instanceId = createHash("sha256").update(`${localServer}\n${directory}`).digest("hex").slice(0, 24)
  const instancePath = join(instancesDir, `${instanceId}.json`)
  const authUsername = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  const authPasswordProtected = protectForCurrentUser(process.env.OPENCODE_SERVER_PASSWORD || "")

  const touchInstance = async () => {
    await atomicJson(instancePath, {
      version: 2,
      backend: "opencode",
      adapterVersion: 1,
      instanceId,
      serverUrl: localServer,
      directory,
      pid: process.pid,
      auth: authPasswordProtected ? {
        kind: "windows-dpapi-basic",
        username: authUsername,
        passwordProtected: authPasswordProtected,
      } : null,
      updatedAt: new Date().toISOString(),
    })
  }

  await touchInstance()

  return {
    event: async ({ event }) => {
      const idle = event?.type === "session.idle"
        || (event?.type === "session.status" && event?.properties?.status?.type === "idle")
      const failed = event?.type === "session.error"
      if (!idle && !failed) return
      // Multiple OpenCode windows can emit terminal events at the same time.
      // A best-effort registry refresh must never prevent the unique event file
      // from being written when Windows briefly locks the shared instance file.
      await touchInstance().catch(() => {})
      if (!(await configured())) return

      const sessionId = event.properties?.sessionID
      let session = null
      let excerpt = ""
      if (sessionId) {
        try {
          session = unwrap(await client.session.get({ path: { id: sessionId }, query: { directory } }))
          const messages = unwrap(await client.session.messages({ path: { id: sessionId }, query: { directory, limit: 12 } }))
          excerpt = lastAssistantText(messages)
        } catch {
          // Completion notification should still be delivered when details cannot be read.
        }
      }

      const payload = {
        version: 1,
        backend: "opencode",
        id: randomUUID(),
        type: failed ? "session.error" : "session.idle",
        createdAt: new Date().toISOString(),
        sessionId: sessionId || null,
        title: session?.title || "OpenCode session",
        directory: session?.directory || directory,
        serverUrl: localServer,
        summary: session?.summary || null,
        excerpt,
        error: failed ? String(event.properties?.error?.data?.message || event.properties?.error?.name || "Unknown error").slice(0, 1000) : null,
      }
      await atomicJson(join(eventsDir, `${Date.now()}-${payload.id}.json`), payload)
    },
  }
}
