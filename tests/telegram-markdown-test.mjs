import assert from "node:assert/strict"
import { escapeMarkdownV2, markdownCode, markdownCodeLanguage, markdownRichInline, telegramMarkdown, telegramMarkdownBody } from "../app/telegram-markdown.mjs"

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

const richReply = telegramMarkdown(`✅ [Codex] 任务已完成

最近回复：
已经完成 **Telegram MarkdownV2** 并上线。

- 使用 \`/home\` 查看
- [GitHub CI](https://github.com/example/repo/actions/runs/1)
- [本地文件](C:/work/file.md)`)
assert.ok(richReply.includes(">已经完成 *Telegram MarkdownV2* 并上线。"))
assert.ok(richReply.includes(">• 使用 `/home` 查看"))
assert.ok(richReply.includes(">• [GitHub CI](https://github.com/example/repo/actions/runs/1)"))
assert.ok(richReply.includes(">• 本地文件 `C:/work/file.md`"))
assert.equal(markdownRichInline("**bold** _plain_"), "*bold* \\_plain\\_")

const fencedReply = telegramMarkdown(`✅ [Codex] 任务已完成

最近回复：
请运行：
\`\`\`shell
tailscale ping <device>
echo \`date\`
\`\`\`
然后检查 JSON：
\`\`\`json
{"direct": "43.200.213.212:41641"}
\`\`\``)
assert.ok(fencedReply.includes(">请运行：\n```bash\ntailscale ping <device>\necho \\`date\\`\n```"))
assert.ok(fencedReply.includes(">然后检查 JSON：\n```json\n{\"direct\": \"43.200.213.212:41641\"}\n```"))
assert.equal(markdownCodeLanguage("ps1"), "powershell")
assert.equal(markdownCodeLanguage("C++"), "cpp")
assert.equal(markdownCodeLanguage("../../bad"), "")

const unclosedFence = telegramMarkdown("Title\n\n最近回复：\n```python\nprint('ok')")
assert.ok(unclosedFence.endsWith("\n```"))

const tableReply = telegramMarkdown(`✅ [Codex] 任务已完成

最近回复：
最简单的定位：

| 组件 | 用途 |
|---|---|
| HAProxy TCP 2443 | 接收 Clash 公网连接 |
| Tailscale | 私密传输阿里云到首尔的数据 |
| Peer Relay | 必要时提供第三台中继 |

结束。`)
assert.ok(!tableReply.includes("|\\-\\-\\-|"))
assert.ok(tableReply.includes(">• *组件：* HAProxy TCP 2443"))
assert.ok(tableReply.includes(">  ↳ *用途：* 接收 Clash 公网连接"))
assert.ok(tableReply.includes(">• *组件：* Tailscale"))
assert.ok(tableReply.includes(">结束。"))

const tableInsideCode = telegramMarkdown("Title\n\n最近回复：\n```text\n| a | b |\n|---|---|\n| 1 | 2 |\n```")
assert.ok(tableInsideCode.includes("| a | b |\n|---|---|\n| 1 | 2 |"))

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
