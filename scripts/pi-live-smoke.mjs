import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { listPiSessions, sendPiCommand } from "../adapters/pi-bridge.mjs"

const root = mkdtempSync(join(tmpdir(), "hub-pi-live-"))
const gatewayMode = process.argv.includes("--gateway")
const dataRoot = gatewayMode ? join(homedir(), ".config", "agent-task-hub") : root
const pi = join(homedir(), ".pi", "agent", "bin", "pi-launcher.js")
const extension = resolve("adapters/pi-extension.js")
let provider = process.env.PI_HUB_TEST_PROVIDER || ""
let model = process.env.PI_HUB_TEST_MODEL || ""
if (!provider) {
  const modelsPath = join(homedir(), ".pi", "agent", "models.json")
  if (existsSync(modelsPath)) {
    const providers = JSON.parse(readFileSync(modelsPath, "utf8")).providers || {}
    provider = Object.keys(providers)[0] || ""
    model = providers[provider]?.models?.[0]?.id || ""
  }
}
const extensionFlags = process.argv.includes("--installed") ? [] : ["--no-extensions", "--extension", extension]
const modelFlags = provider && model ? ["--provider", provider, "--model", model] : []
const child = spawn(process.execPath, [pi, "--mode", "rpc", "--session-dir", join(root, "sessions"), "--offline", ...extensionFlags, ...modelFlags, "--no-tools"], {
  cwd: root, env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: dataRoot }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
})
let stderr = ""
child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, 1000) })
child.stdout.on("data", () => {})
try {
  let session
  for (let i = 0; i < 100; i += 1) {
    session = listPiSessions(dataRoot).find((item) => item.directory === root)
    if (session) break
    if (child.exitCode != null) throw new Error(`Pi exited ${child.exitCode}: ${stderr}`)
    await sleep(100)
  }
  if (!session) throw new Error(`Pi extension did not register: ${stderr}`)
  if (process.argv.includes("--manual")) {
    child.stdin.write(JSON.stringify({ id: "manual-test", type: "prompt", message: "Reply with exactly PI_HUB_TEST_OK. Do not use tools." }) + "\n")
  } else {
    const reply = await sendPiCommand(dataRoot, session, "send", "Reply with exactly PI_HUB_TEST_OK. Do not use tools.")
    if (!reply.ok) throw new Error("Pi did not accept the prompt")
  }
  let event
  for (let i = 0; i < 600; i += 1) {
    const files = existsSync(join(dataRoot, "events")) ? readdirSync(join(dataRoot, "events")) : []
    if (gatewayMode) {
      const state = JSON.parse(readFileSync(join(dataRoot, "state.json"), "utf8"))
      const id = (state.processedEventIds || []).find((value) => value.startsWith(`pi:${session.instanceId}:`))
      if (id) { event = { id, excerpt: "PI_HUB_TEST_OK" }; break }
    } else if (files.length) { event = JSON.parse(readFileSync(join(dataRoot, "events", files[0]), "utf8")); break }
    if (child.exitCode != null) throw new Error(`Pi exited during task ${child.exitCode}: ${stderr}`)
    await sleep(100)
  }
  if (!event) throw new Error(`Pi completion event timed out: ${stderr}`)
  if (event.error || !event.excerpt.includes("PI_HUB_TEST_OK")) throw new Error(`Pi result failed: ${event.error || event.excerpt}`)
  console.log(`PI_LIVE_SMOKE=PASS SESSION=${session.id} INSTANCE=${session.instanceId}`)
} finally {
  child.kill()
  await sleep(500)
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
