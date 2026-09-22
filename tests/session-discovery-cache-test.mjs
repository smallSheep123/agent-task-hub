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
await delay(0)
assert.deepEqual(cache.snapshot("zcode"), [{ id: "two" }])

cache.remember("zcode", { id: "three" })
cache.remember("zcode", { id: "two", title: "updated" })
assert.deepEqual(cache.snapshot("zcode").map((item) => item.id), ["two", "three"])
assert.equal(cache.snapshot("zcode")[0].title, "updated")

await delay(25)
assert.deepEqual(await cache.get("zcode", async () => { throw new Error("offline") }), [{ id: "two", title: "updated" }, { id: "three" }])
await delay(0)
assert.deepEqual(errors, [["zcode", "offline"]])
console.log("SESSION_DISCOVERY_CACHE_TEST=PASS")
