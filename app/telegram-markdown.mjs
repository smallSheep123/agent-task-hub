const MARKDOWN_V2_SPECIAL = /[\\_*\[\]()~`>#+\-=|{}.!]/g

const CODE_VALUE_LABELS = new Set([
  "ID", "Agent", "Status", "Directory", "Turns", "Type", "Progress",
  "状态", "目录", "轮次", "类型", "进度", "权限",
])

const FIELD_LABELS = new Set([
  ...CODE_VALUE_LABELS,
  "Session", "Permission", "Task", "Reason", "Pending todos", "Language", "Telegram",
  "OpenCode Desktop", "Codex adapter", "Plugin instances", "Available sessions", "Selected session",
  "Pending requests", "Queue", "Uptime", "Latest error", "Current entry", "Selected", "Source",
  "Duration", "Remaining", "Next", "Changes", "Error", "Elapsed", "Waiting", "Queue mode", "Active item",
  "会话", "任务", "原因", "待办", "界面语言", "OpenCode Desktop", "Codex 适配器", "插件实例",
  "可用会话", "当前会话", "待处理请求", "队列", "本次运行", "最近错误", "当前入口", "当前选择",
  "来源", "耗时", "剩余", "下一条", "改动", "错误", "已运行", "等待数量", "队列状态", "当前队列任务",
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

function markdownLinkUrl(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\)/g, "\\)")
}

export function markdownRichInline(value) {
  const input = String(value ?? "")
  const token = /(\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\))/g
  let output = ""
  let cursor = 0
  for (const match of input.matchAll(token)) {
    output += escapeMarkdownV2(input.slice(cursor, match.index))
    const bold = match[2] ?? match[3]
    if (bold !== undefined) output += markdownBold(bold)
    else if (match[4] !== undefined) output += markdownCode(match[4])
    else {
      const label = match[5]
      const destination = match[6]
      output += /^https?:\/\//i.test(destination)
        ? `[${escapeMarkdownV2(label)}](${markdownLinkUrl(destination)})`
        : `${escapeMarkdownV2(label)} ${markdownCode(destination)}`
    }
    cursor = Number(match.index) + match[0].length
  }
  return output + escapeMarkdownV2(input.slice(cursor))
}

export function markdownRichQuoteLine(value) {
  const line = String(value ?? "")
  const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/)
  if (heading) return `>${markdownBold(heading[1])}`
  const bullet = line.match(/^\s*[-*+]\s+(.+)$/)
  if (bullet) return `>• ${markdownRichInline(bullet[1])}`
  const numbered = line.match(/^\s*(\d{1,3})[.)]\s+(.+)$/)
  if (numbered) return `>${escapeMarkdownV2(`${numbered[1]}.`)} ${markdownRichInline(numbered[2])}`
  const nestedQuote = line.match(/^\s*>\s?(.*)$/)
  if (nestedQuote) return `>▌ ${markdownRichInline(nestedQuote[1])}`
  return `>${markdownRichInline(line)}`
}

function labelLine(line) {
  const match = String(line).match(/^\s*([^：:\r\n]{2,32})([：:])(?:\s*)(.*)$/u)
  if (!match) return null
  const label = match[1].trim()
  if (!FIELD_LABELS.has(label)) return null
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
    if (quoteToEnd) return markdownRichQuoteLine(line)

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
