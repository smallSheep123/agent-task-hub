export function timestampMilliseconds(value) {
  if (value === null || value === undefined || value === "") return 0
  let number = Number(value)
  if (!Number.isFinite(number)) {
    const parsed = Date.parse(String(value))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  if (number > 0 && number < 1e12) number *= 1000
  return Number.isFinite(number) && number > 0 ? number : 0
}

export function elapsedDurationParts(start, end = Date.now()) {
  const startMs = timestampMilliseconds(start)
  const endMs = timestampMilliseconds(end)
  if (!startMs || !endMs) return null
  const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000))
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalSeconds,
  }
}

export function isRunningStatus(status) {
  const value = String(typeof status === "string" ? status : status?.type || "").toLowerCase()
  return ["active", "busy", "inprogress", "retry", "running", "working"].includes(value)
}

function openCodeMessageTime(message) {
  return timestampMilliseconds(message?.info?.time?.created || message?.info?.time?.updated || message?.info?.time?.completed)
}

export function openCodeTaskStartedAt(messages) {
  const ordered = (Array.isArray(messages) ? messages : [])
    .filter((message) => openCodeMessageTime(message) > 0)
    .sort((left, right) => openCodeMessageTime(left) - openCodeMessageTime(right))
  let latestCompletedAssistant = 0
  for (const message of ordered) {
    if (message?.info?.role !== "assistant" || !message?.info?.time?.completed) continue
    latestCompletedAssistant = Math.max(latestCompletedAssistant, timestampMilliseconds(message.info.time.completed))
  }
  const currentUsers = ordered.filter((message) => message?.info?.role === "user" && openCodeMessageTime(message) >= latestCompletedAssistant)
  const candidate = currentUsers[0] || [...ordered].reverse().find((message) => message?.info?.role === "user")
  return candidate ? openCodeMessageTime(candidate) : 0
}

export function codexTaskStartedAt(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const turn = turns.at(-1)
  if (!turn?.startedAt || turn?.completedAt) return 0
  return timestampMilliseconds(turn?.startedAt)
}

export function codexThreadAppearsActive(thread) {
  return codexTaskStartedAt(thread) > 0
}

export function pendingBreakdown({ approvals = 0, questions = 0 } = {}) {
  return { approvals: Math.max(0, Number(approvals) || 0), questions: Math.max(0, Number(questions) || 0) }
}
