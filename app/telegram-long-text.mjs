import { telegramMarkdown } from "./telegram-markdown.mjs"

export function telegramTextParts(value, { language = "en-US", maxLength = 1800 } = {}) {
  const text = String(value ?? "").replace(/\0/g, "").trim()
  if (telegramMarkdown(text, Number.MAX_SAFE_INTEGER).length <= 4000) return [{ text, formatted: true }]

  const characters = Array.from(text)
  const chunks = []
  for (let start = 0; start < characters.length;) {
    let end = Math.min(start + maxLength, characters.length)
    if (end < characters.length) {
      const newline = characters.lastIndexOf("\n", end - 1)
      if (newline > start + Math.floor(maxLength / 2)) end = newline + 1
    }
    chunks.push(characters.slice(start, end).join(""))
    start = end
  }
  return chunks.map((chunk, index) => ({
    text: `${language === "zh-CN" ? `第 ${index + 1}/${chunks.length} 部分` : `Part ${index + 1}/${chunks.length}`}\n${chunk}`,
    formatted: false,
  }))
}
