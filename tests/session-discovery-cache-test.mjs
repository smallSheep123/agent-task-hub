import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { SessionDiscoveryCache } from "../app/session-discovery-cache.mjs"

let loads = 0
const errors = []
const cache = new SessionDiscoveryCache({ ttlMs: 20, initialWaitMs: 10, onError: (name, error) => errors.push([name, error.message]) })
const firstStarted = Date.now()
const first = await cache.get("zcode", async () => {
  loads += 1
  await delay(40)
  return [{ id: "one" }]
})
assert.deepEqual(first, [])
assert.ok(Date.now() - firstStarted < 35)
await delay(35)
assert.deepEqual(cache.snapshot("zcode"), [{ id: "one" }])
assert.equal(loads, 1)

await delay(25)
let release
const staleStarted = Date.now()
const stale = await cache.get("zcode", () => new Promise((resolve) => { release = resolve }))
assert.deepEqual(stale, [{ id: "one" }])
assert.ok(Date.now() - staleStarted < 20)
await delay(0)
release([{ id: "two" }])
await cache.whenIdle(["zcode"])
assert.deepEqual(cache.snapshot("zcode"), [{ id: "two" }])

cache.remember("zcode", { id: "three" })
cache.remember("zcode", { id: "two", title: "updated" })
assert.deepEqual(cache.snapshot("zcode").map((item) => item.id), ["two", "three"])
assert.equal(cache.snapshot("zcode")[0].title, "updated")

await delay(25)
assert.deepEqual(await cache.get("zcode", async () => { throw new Error("offline") }), [{ id: "two", title: "updated" }, { id: "three" }])
await delay(0)
assert.deepEqual(errors, [["zcode", "offline"]])

const piCache = new SessionDiscoveryCache({ ttlMs: 10, initialWaitMs: 20 })
assert.deepEqual(await piCache.get("pi", async () => [{ id: "closed", status: "closed" }], { waitForStale: true }), [{ id: "closed", status: "closed" }])
await delay(15)
const refreshed = await piCache.get("pi", async () => [{ id: "live", status: "idle" }], { waitForStale: true })
assert.deepEqual(refreshed, [{ id: "live", status: "idle" }])

await delay(15)
let finishPiRefresh
const timedOut = await piCache.get("pi", () => new Promise((resolve) => { finishPiRefresh = resolve }), { waitForStale: true })
assert.deepEqual(timedOut, [{ id: "live", status: "idle" }])
finishPiRefresh([{ id: "busy", status: "busy" }])
await piCache.whenIdle(["pi"])
assert.deepEqual(piCache.snapshot("pi"), [{ id: "busy", status: "busy" }])
console.log("SESSION_DISCOVERY_CACHE_TEST=PASS")
