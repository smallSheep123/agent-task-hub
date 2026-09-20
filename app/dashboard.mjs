export function timestampMilliseconds(value) {
  let number = Number(value || 0)
  if (number > 0 && number < 1e12) number *= 1000
  return Number.isFinite(number) && number > 0 ? number : 0
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
  const turn = [...(Array.isArray(thread?.turns) ? thread.turns : [])].reverse().find((item) => item?.status === "inProgress" || (item?.startedAt && !item?.completedAt))
  return timestampMilliseconds(turn?.startedAt)
}

export function pendingBreakdown({ approvals = 0, questions = 0 } = {}) {
  return { approvals: Math.max(0, Number(approvals) || 0), questions: Math.max(0, Number(questions) || 0) }
}
