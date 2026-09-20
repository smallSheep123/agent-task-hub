import assert from "node:assert/strict"
import { escapeMarkdownV2, markdownCode, telegramMarkdown, telegramMarkdownBody } from "../app/telegram-markdown.mjs"

assert.equal(escapeMarkdownV2("a_b [c](d).js + 1!"), "a\\_b \\[c\\]\\(d\\)\\.js \\+ 1\\!")
assert.equal(markdownCode("D:\\A_B\\`draft`"), "`D:\\\\A_B\\\\\\`draft\\``")

const dashboard = telegramMarkdown(`Agent Task Hub · 运行看板

当前选择：Codex · 修复 [parser]_v2

🟢 Codex：运行 1 · 排队 0 · 会话 27
1. 修复 [parser]_v2
   已运行 3 分 18 秒
   D:\\AIGC\\project_v2`)
assert.match(dashboard, /^\*Agent Task Hub · 运行看板\*/)
assert.ok(dashboard.includes("*当前选择：* Codex · 修复 \\[parser\\]\\_v2"))
assert.match(dashboard, /\*🟢 Codex：运行 1 · 排队 0 · 会话 27\*/)
assert.match(dashboard, /D:\\\\AIGC\\\\project\\_v2/)

const details = telegramMarkdown(`【Project [v2]】
状态：busy
目录：D:\\AIGC\\project_v2

最近回复：
Fixed _all_ [items].`)
assert.match(details, /\*状态：\* `busy`/)
assert.match(details, /\*目录：\* `D:\\\\AIGC\\\\project_v2`/)
assert.ok(details.includes("*最近回复：*\n>Fixed \\_all\\_ \\[items\\]\\."))

const help = telegramMarkdown("Agent Task Hub\n\n/add 内容 — 追加队列")
assert.match(help, /`\/add 内容` — 追加队列/)

const sessionTitleWithColon = telegramMarkdown(`全部 Agent 会话（27 个，第 1/5 页）：

4️⃣ Codex · idle
📝「/D:\\AIGC/proxy/NEW_NODE.md 网速已测试」
📁 D:\\AIGC\\proxy`)
assert.ok(!sessionTitleWithColon.includes("*📝「/D:*"))
assert.ok(sessionTitleWithColon.includes("4️⃣ Codex · idle"))
assert.ok(sessionTitleWithColon.includes("📝「/D:\\\\AIGC/proxy/NEW\\_NODE\\.md 网速已测试」"))

const bounded = telegramMarkdown("Title\n" + "_[x]. ".repeat(2000))
assert.ok(bounded.length <= 4000)
assert.equal(telegramMarkdownBody("Title").parse_mode, "MarkdownV2")

console.log("TELEGRAM_MARKDOWN_TEST=PASS")
