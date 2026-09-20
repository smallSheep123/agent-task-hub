import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const service = readFileSync(new URL("../scripts/service.ps1", import.meta.url), "utf8")

assert.match(service, /-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass/)
assert.match(service, /if \(Get-BridgeTask\) \{ Stop-BridgeTask \}/)
assert.match(service, /New-ScheduledTaskAction -Execute \$powershell/)

console.log("SERVICE_LAUNCH_TEST=PASS")
