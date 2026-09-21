import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const service = readFileSync(new URL("../scripts/service.ps1", import.meta.url), "utf8")
const launcher = readFileSync(new URL("../app/run-controller.ps1", import.meta.url), "utf8")

assert.match(service, /-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass/)
assert.match(service, /if \(Get-BridgeTask\) \{ Stop-BridgeTask \}/)
assert.match(service, /New-ScheduledTaskAction -Execute \$powershell/)
assert.match(launcher, /config\.outboundProxy/)
assert.match(launcher, /--use-env-proxy/)
assert.match(launcher, /NO_PROXY/)

console.log("SERVICE_LAUNCH_TEST=PASS")
