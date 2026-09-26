import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

const [sessionFile, directory, workerId] = process.argv.slice(2)
const dataRoot = process.env.AGENT_TASK_HUB_DATA_DIR || join(homedir(), ".config", "agent-task-hub")
const statusPath = join(dataRoot, "pi", "workers", `${workerId}.json`)
const status = (value) => {
  mkdirSync(dirname(statusPath), { recursive: true })
  const temp = `${statusPath}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify({ workerId, sessionFile, directory, workerPid: process.pid, at: new Date().toISOString(), ...value }), { mode: 0o600 })
  renameSync(temp, statusPath)
}

try {
  if (!/^[a-f0-9-]{36}$/.test(workerId || "")) throw new Error("Invalid worker ID")
  if (!sessionFile || !statSync(sessionFile).isFile()) throw new Error("Pi session file is missing")
  if (!directory || !statSync(directory).isDirectory()) throw new Error("Pi project directory is missing")
  const launcher = join(homedir(), ".pi", "agent", "bin", "pi-launcher.js")
  if (!existsSync(launcher)) throw new Error("Pi launcher is missing")
  const child = spawn(process.execPath, [launcher, "--mode", "rpc", "--session", resolve(sessionFile), "--offline"], {
    cwd: resolve(directory), env: { ...process.env, AGENT_TASK_HUB_DATA_DIR: dataRoot, AGENT_TASK_HUB_WORKER_ID: workerId },
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  })
  let recentError = ""
  child.stdout.on("data", () => {})
  child.stderr.on("data", (chunk) => { recentError = `${recentError}${String(chunk)}`.slice(-1500) })
  child.on("error", (error) => status({ state: "failed", error: error.message }))
  status({ state: "starting", childPid: child.pid })
  const deadline = Date.now() + 30000
  const readyTimer = setInterval(() => {
    const instancesDir = join(dataRoot, "pi", "instances")
    if (existsSync(instancesDir)) for (const name of readdirSync(instancesDir)) {
      if (!/^[a-f0-9]{12}\.json$/.test(name)) continue
      let item
      try { item = JSON.parse(readFileSync(join(instancesDir, name), "utf8")) } catch { continue }
      if (item.workerId === workerId) {
        clearInterval(readyTimer)
        status({ state: "ready", childPid: child.pid, instanceId: item.instanceId })
        return
      }
    }
    if (Date.now() >= deadline) {
      clearInterval(readyTimer)
      status({ state: "failed", error: "Pi extension did not register within 30 seconds" })
      child.kill()
    }
  }, 250)
  process.on("SIGTERM", () => child.kill())
  child.on("exit", (code, signal) => {
    clearInterval(readyTimer)
    status({ state: "exited", code, signal, error: recentError })
    process.exit(code || 0)
  })
} catch (error) {
  status({ state: "failed", error: String(error?.message || error) })
  process.exitCode = 1
}
