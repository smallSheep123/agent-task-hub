import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { findPiHistory, listPiSessions, piResumeCommand, sendPiCommand } from "../adapters/pi-bridge.mjs"

const testRoot = mkdtempSync(join(tmpdir(), "hub-pi-multi-"))
const dataRoot = join(homedir(), ".config", "agent-task-hub")
const launcher = join(homedir(), ".pi", "agent", "bin", "pi-launcher.js")
const modelsFile = join(homedir(), ".pi", "agent", "models.json")
const providers = existsSync(modelsFile) ? JSON.parse(readFileSync(modelsFile, "utf8")).providers || {} : {}
const provider = process.env.PI_HUB_TEST_PROVIDER || Object.keys(providers)[0] || ""
const model = process.env.PI_HUB_TEST_MODEL || providers[provider]?.models?.[0]?.id || ""
const modelArgs = provider && model ? ["--provider", provider, "--model", model] : []
const children = []
const processOutput = []
const dirs = [join(testRoot, "alpha"), join(testRoot, "beta")]
for (const directory of dirs) mkdirSync(directory, { recursive: true })

const waitFor = async (predicate, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out: ${label}; processes=${JSON.stringify(children.map((child, index) => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, output: processOutput[index]?.slice(-800) || "" })))}`)
}
const processed = (instanceId) => {
  const state = JSON.parse(readFileSync(join(dataRoot, "state.json"), "utf8"))
  return (state.processedEventIds || []).find((id) => id.startsWith(`pi:${instanceId}:`))
}

try {
  for (const directory of dirs) {
    const child = spawn(process.execPath, [launcher, "--mode", "rpc", "--session-dir", join(directory, "sessions"), "--offline", ...modelArgs, "--no-tools"], {
      cwd: directory, env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: dataRoot }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    })
    const index = children.length
    processOutput[index] = ""
    child.stdout.on("data", (chunk) => { processOutput[index] += String(chunk) })
    child.stderr.on("data", (chunk) => { processOutput[index] += String(chunk) })
    children.push(child)
  }
  const sessions = await waitFor(() => {
    const live = listPiSessions(dataRoot)
    const found = dirs.map((dir) => live.find((item) => item.directory === dir))
    return found.every(Boolean) ? found : null
  }, "both Pi terminals registered")
  if (sessions[0].instanceId === sessions[1].instanceId || sessions[0].id === sessions[1].id) throw new Error("Pi terminals were merged")

  await sendPiCommand(dataRoot, sessions[0], "send", "Reply with exactly PI_ALPHA_OK. Do not use tools.")
  await waitFor(() => processed(sessions[0].instanceId), "alpha completion", 60000)
  const history = findPiHistory(dataRoot, sessions[0].id)
  if (!history?.sessionFile || !piResumeCommand(history)?.includes("--session")) throw new Error("Alpha resume metadata was not recorded")
  if (processed(sessions[1].instanceId)) throw new Error("Beta received Alpha's completion")
  await sendPiCommand(dataRoot, sessions[1], "send", "Reply with exactly PI_BETA_OK. Do not use tools.")
  await waitFor(() => processed(sessions[1].instanceId), "beta completion", 60000)

  children[0].kill()
  await waitFor(() => !listPiSessions(dataRoot).some((item) => item.instanceId === sessions[0].instanceId), "alpha offline", 25000)
  if (!listPiSessions(dataRoot).some((item) => item.instanceId === sessions[1].instanceId)) throw new Error("Beta disappeared with Alpha")
  const savedFile = readdirSync(join(dirs[0], "sessions")).find((name) => name.endsWith(".jsonl"))
  if (!savedFile) throw new Error("Pi did not persist Alpha's session")
  const workerId = randomUUID()
  const workerScript = fileURLToPath(new URL("./pi-worker.mjs", import.meta.url))
  const resumed = spawn(process.execPath, [workerScript, join(dirs[0], "sessions", savedFile), dirs[1], workerId], {
    cwd: dirs[1], env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: dataRoot }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  })
  resumed.stdout.on("data", () => {})
  resumed.stderr.on("data", () => {})
  children.push(resumed)
  const resumedSession = await waitFor(() => listPiSessions(dataRoot).find((item) => item.id === sessions[0].id && item.workerId === workerId), "Alpha session resumed by background worker")
  const workerStatus = JSON.parse(readFileSync(join(dataRoot, "pi", "workers", `${workerId}.json`), "utf8"))
  if (!["starting", "ready"].includes(workerStatus.state)) throw new Error("Pi background worker did not start")
  if (resumedSession.directory !== dirs[0]) throw new Error("Pi resumed in the wrong project directory")
  console.log(`PI_MULTI_PROCESS=PASS ALPHA=${sessions[0].id}/${sessions[0].instanceId} BETA=${sessions[1].id}/${sessions[1].instanceId} RESUMED_CWD=${resumedSession.directory}`)
} finally {
  for (const child of children) child.kill()
  await sleep(500)
  const instanceDir = join(dataRoot, "pi", "instances")
  if (existsSync(instanceDir)) for (const name of readdirSync(instanceDir)) {
    const path = join(instanceDir, name)
    let item
    try { item = JSON.parse(readFileSync(path, "utf8")) } catch { continue }
    if (!String(item.directory || "").startsWith(`${testRoot}\\`) || !/^[a-f0-9]{12}$/.test(item.instanceId || "")) continue
    rmSync(path, { force: true })
    rmSync(join(dataRoot, "pi", "inbox", item.instanceId), { recursive: true, force: true })
    rmSync(join(dataRoot, "pi", "replies", item.instanceId), { recursive: true, force: true })
  }
  const historyDir = join(dataRoot, "pi", "history")
  if (existsSync(historyDir)) for (const name of readdirSync(historyDir)) {
    const path = join(historyDir, name)
    let item
    try { item = JSON.parse(readFileSync(path, "utf8")) } catch { continue }
    if (String(item.sessionFile || "").startsWith(`${testRoot}\\`)) rmSync(path, { force: true })
  }
  const workersDir = join(dataRoot, "pi", "workers")
  if (existsSync(workersDir)) for (const name of readdirSync(workersDir)) {
    const path = join(workersDir, name)
    let item
    try { item = JSON.parse(readFileSync(path, "utf8")) } catch { continue }
    if (String(item.sessionFile || "").startsWith(`${testRoot}\\`)) rmSync(path, { force: true })
  }
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
