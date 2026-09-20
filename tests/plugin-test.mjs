import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import assert from "node:assert/strict"

const root = await mkdtemp(join(tmpdir(), "agent-task-hub-opencode-"))
process.env.AGENT_TASK_HUB_DATA_DIR = root
process.env.OPENCODE_SERVER_USERNAME = "opencode"
process.env.OPENCODE_SERVER_PASSWORD = "temporary-local-password"
await writeFile(join(root, "config.json"), "{}", "utf8")
const { TelegramBridgePlugin } = await import(`../adapters/opencode.js?test=${Date.now()}`)

const client = {
  session: {
    async get() { return { data: { id: "ses_test", title: "测试项目", directory: "D:/work/test", summary: { files: 2, additions: 12, deletions: 3 } } } },
    async messages() { return { data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "测试已全部通过。" }] }] } },
  },
}

const hooks = await TelegramBridgePlugin({ client, directory: "D:/work/test", serverUrl: new URL("http://127.0.0.1:4096") })
await Promise.all([
  hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } }),
  hooks.event({ event: { type: "session.status", properties: { sessionID: "ses_test", status: { type: "idle" } } } }),
])
const instances = await readdir(join(root, "instances"))
const events = await readdir(join(root, "events"))
assert.equal(instances.length, 1)
const instanceText = await readFile(join(root, "instances", instances[0]), "utf8")
const instance = JSON.parse(instanceText)
assert.equal(instance.version, 2)
assert.equal(instance.backend, "opencode")
assert.equal(instance.adapterVersion, 1)
assert.equal(instance.auth.kind, "windows-dpapi-basic")
assert.ok(instance.auth.passwordProtected)
assert.doesNotMatch(instanceText, /temporary-local-password/)
assert.equal(events.length, 2)
const event = JSON.parse(await readFile(join(root, "events", events[0]), "utf8"))
assert.equal(event.sessionId, "ses_test")
assert.equal(event.backend, "opencode")
assert.equal(event.title, "测试项目")
assert.match(event.excerpt, /全部通过/)

const blockedRoot = await mkdtemp(join(tmpdir(), "agent-task-hub-opencode-blocked-"))
process.env.AGENT_TASK_HUB_DATA_DIR = blockedRoot
const blockedModule = await import(`../adapters/opencode.js?blocked=${Date.now()}`)
const blocked = await blockedModule.TelegramBridgePlugin({ client, directory: "D:/work/test", serverUrl: new URL("http://192.168.1.10:4096") })
await blocked.event({ event: { type: "session.idle", properties: { sessionID: "ses_test" } } })
assert.equal((await readdir(join(blockedRoot, "events"))).length, 0)

await rm(root, { recursive: true, force: true })
await rm(blockedRoot, { recursive: true, force: true })
console.log("PLUGIN_TEST=PASS")
