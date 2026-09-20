import assert from "node:assert/strict"
import { createI18n } from "../app/locales.mjs"

for (const language of ["zh-CN", "en-US"]) {
  const i18n = createI18n(language)
  assert.equal(i18n.language, language)
  assert.equal(i18n.commands().length, 11)
  assert.ok(i18n.commands().every(({ command, description }) => command && description))
  assert.match(i18n.t("help"), /\/batch/)
  assert.match(i18n.t("home", "mode", "session", 1, "offline"), /Agent Task Hub/)
  assert.doesNotMatch(i18n.t("health", ...Array(9).fill("ok")), /\{\d+\}/)
}

assert.match(createI18n("zh-CN").t("onlineAnnouncement"), /已上线/)
assert.match(createI18n("en-US").t("onlineAnnouncement"), /online/)
assert.deepEqual(createI18n("en-US").commands().slice(0, 4).map((item) => item.command), ["home", "sessions", "opencode", "codex"])
assert.equal(createI18n("unsupported").language, "en-US")
console.log("I18N_TEST=PASS")
