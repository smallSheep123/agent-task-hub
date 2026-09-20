const MARKDOWN_V2_SPECIAL = /[\\_*\[\]()~`>#+\-=|{}.!]/g

const CODE_VALUE_LABELS = new Set([
  "ID", "Agent", "Status", "Directory", "Turns", "Type", "Progress",
  "状态", "目录", "轮次", "类型", "进度", "权限",
])

const QUOTE_TO_END_HEADINGS = new Set(["最近回复：", "Latest reply:"])
const QUOTE_SECTION_HEADINGS = new Set(["详情：", "Details:", "目标：", "Targets:", "错误：", "Error:"])

export function escapeMarkdownV2(value) {
  return String(value ?? "").replace(MARKDOWN_V2_SPECIAL, "\\$&")
}

export function markdownBold(value) {
  return `*${escapeMarkdownV2(value)}*`
}

export function markdownCode(value) {
  return `\`${String(value ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``
}

export function markdownQuote(value) {
  return String(value ?? "").split("\n").map((line) => `>${escapeMarkdownV2(line)}`).join("\n")
}

function labelLine(line) {
  const match = String(line).match(/^\s*([^：:\r\n]{2,32})([：:])(?:\s*)(.*)$/u)
  if (!match) return null
  const label = match[1].trim()
  if (/^https?$/i.test(label) || /^[A-Za-z]$/.test(label)) return null
  return { label, value: match[3] }
}

function renderMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").trim().split("\n")
  const firstContent = lines.findIndex((line) => line.trim())
  let quoteToEnd = false
  let quoteSection = false
  return lines.map((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) {
      if (quoteToEnd) return ">"
      quoteSection = false
      return ""
    }

    if (QUOTE_TO_END_HEADINGS.has(trimmed)) {
      quoteToEnd = true
      quoteSection = false
      return markdownBold(trimmed)
    }
    if (QUOTE_SECTION_HEADINGS.has(trimmed)) {
      quoteSection = true
      return markdownBold(trimmed)
    }
    if (quoteToEnd) return markdownQuote(line)

    const labeled = labelLine(line)
    if (quoteSection && labeled) quoteSection = false
    if (quoteSection) return markdownQuote(line)

    const command = line.match(/^\s*(\/[A-Za-z][A-Za-z0-9_]*(?:\s+.*)?)\s+—\s+(.+)$/u)
    if (command) return `${markdownCode(command[1])} — ${escapeMarkdownV2(command[2])}`

    if (/^[🟢🔴]\s+.*(?:OpenCode|Codex).*[:：]/u.test(trimmed)) return markdownBold(trimmed)
    if (index === firstContent) return markdownBold(trimmed)

    if (labeled) {
      const renderedValue = CODE_VALUE_LABELS.has(labeled.label) && labeled.value
        ? markdownCode(labeled.value)
        : escapeMarkdownV2(labeled.value)
      return `${markdownBold(`${labeled.label}${line.includes("：") ? "：" : ":"}`)}${renderedValue ? ` ${renderedValue}` : ""}`
    }
    return escapeMarkdownV2(line)
  }).join("\n")
}

export function telegramMarkdown(value, maxLength = 4000) {
  const plain = String(value ?? "").replace(/\0/g, "").trim()
  let rendered = renderMarkdown(plain)
  if (rendered.length <= maxLength) return rendered

  let low = 0
  let high = plain.length
  let best = ""
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = renderMarkdown(`${plain.slice(0, middle).trimEnd()}\n…`)
    if (candidate.length <= maxLength) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best || markdownBold("…")
}

export function telegramMarkdownBody(text, extra = {}) {
  return { text: telegramMarkdown(text), parse_mode: "MarkdownV2", ...extra }
}
