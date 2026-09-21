import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexAppServer, normalizeCodexTransport, resolveCodexLaunch } from "../adapters/codex-app-server.mjs"

assert.equal(normalizeCodexTransport("shared"), "shared")
assert.equal(normalizeCodexTransport("AUTO"), "auto")
assert.equal(normalizeCodexTransport("unknown"), "private")

const privateLaunch = resolveCodexLaunch("missing-codex-for-test", "private")
assert.deepEqual(privateLaunch.args.slice(-2), ["app-server", "--stdio"])
assert.equal(privateLaunch.transport, "private")

const sharedLaunch = resolveCodexLaunch("missing-codex-for-test", "shared")
assert.deepEqual(sharedLaunch.args.slice(-2), ["app-server", "proxy"])
assert.equal(sharedLaunch.transport, "shared")

class FakeChild extends EventEmitter {
  constructor(available) {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitCode = null
    this.killed = false
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      if (!available) return
      buffer += String(chunk)
      while (buffer.includes("\n")) {
        const offset = buffer.indexOf("\n")
        const line = buffer.slice(0, offset)
        buffer = buffer.slice(offset + 1)
        if (!line) continue
        const request = JSON.parse(line)
        if (request.method === "initialize" && request.id !== undefined) {
          this.stdout.write(JSON.stringify({ id: request.id, result: { serverInfo: { name: "fake" } } }) + "\n")
        }
      }
    })
    if (!available) queueMicrotask(() => {
      this.stderr.write("managed daemon is unavailable")
      this.exitCode = 1
      this.emit("exit", 1, null)
    })
  }

  kill() {
    if (this.exitCode !== null) return false
    this.killed = true
    this.exitCode = 0
    queueMicrotask(() => this.emit("exit", 0, null))
    return true
  }
}

const launches = []
const client = new CodexAppServer({
  command: "missing-codex-for-test",
  transport: "auto",
  requestTimeoutMs: 200,
  sharedConnectTimeoutMs: 100,
  spawnFactory(command, args) {
    launches.push({ command, args })
    return new FakeChild(!args.includes("proxy"))
  },
})

const diagnostics = []
client.on("diagnostic", (message) => diagnostics.push(message))
await client.start()
assert.equal(client.ready, true)
assert.equal(client.transport, "private")
assert.equal(launches.length, 2)
assert.deepEqual(launches[0].args.slice(-2), ["app-server", "proxy"])
assert.deepEqual(launches[1].args.slice(-2), ["app-server", "--stdio"])
assert.ok(diagnostics.some((message) => message.includes("falling back to private stdio")))
await client.stop()
assert.equal(client.ready, false)

class FakeWebSocket {
  constructor() {
    this.readyState = 0
    this.listeners = new Map()
    queueMicrotask(() => {
      this.readyState = 1
      this.emit("open", {})
    })
  }

  addEventListener(name, listener, options = {}) {
    const wrapped = options.once
      ? (event) => { this.removeEventListener(name, wrapped); listener(event) }
      : listener
    const listeners = this.listeners.get(name) || []
    listeners.push(wrapped)
    this.listeners.set(name, listeners)
  }

  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== listener))
  }

  emit(name, event) {
    for (const listener of [...(this.listeners.get(name) || [])]) listener(event)
  }

  send(serialized) {
    const request = JSON.parse(serialized)
    if (request.method === "initialize" && request.id !== undefined) queueMicrotask(() => {
      this.emit("message", { data: JSON.stringify({ id: request.id, result: { serverInfo: { name: "fake-ws" } } }) })
    })
  }

  close(code = 1000, reason = "") {
    this.readyState = 3
    queueMicrotask(() => this.emit("close", { code, reason }))
  }
}

const websocketClient = new CodexAppServer({
  transport: "shared",
  wsUrl: "ws://127.0.0.1:9234",
  requestTimeoutMs: 200,
  sharedConnectTimeoutMs: 100,
  webSocketFactory: () => new FakeWebSocket(),
})
await websocketClient.start()
assert.equal(websocketClient.transport, "shared-websocket")
assert.equal(websocketClient.ready, true)
await websocketClient.stop()
assert.equal(websocketClient.ready, false)

console.log("CODEX_TRANSPORT_TEST=PASS")
