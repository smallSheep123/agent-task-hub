import { createHash } from "node:crypto"

export function openCodeQuestionToken(serverUrl, requestId) {
  return createHash("sha256").update(`${String(serverUrl)}\n${String(requestId)}`).digest("hex").slice(0, 16)
}

export function normalizeOpenCodeQuestion(raw) {
  if (!raw?.id || !raw?.sessionID || !Array.isArray(raw.questions) || !raw.questions.length) return null
  const questions = raw.questions.map((question) => ({
    header: String(question?.header || "").slice(0, 80),
    question: String(question?.question || "").slice(0, 3000),
    options: Array.isArray(question?.options)
      ? question.options.slice(0, 20).map((option) => ({
          label: String(option?.label || "").slice(0, 200),
          description: String(option?.description || "").slice(0, 1000),
        })).filter((option) => option.label)
      : [],
    multiple: Boolean(question?.multiple),
    custom: Boolean(question?.custom),
  }))
  if (questions.some((question) => !question.question)) return null
  return {
    requestId: String(raw.id),
    sessionId: String(raw.sessionID),
    questions,
    tool: raw.tool && typeof raw.tool === "object" ? raw.tool : null,
  }
}

export function nextOpenCodeQuestionIndex(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const completed = request?.completedQuestions || {}
  return questions.findIndex((_, index) => !completed[index])
}

export function chooseOpenCodeQuestionOption(request, questionIndex, label) {
  const question = request?.questions?.[questionIndex]
  if (!question) throw new Error("Question not found")
  request.answers ||= {}
  request.completedQuestions ||= {}
  if (question.multiple) {
    const selected = new Set(Array.isArray(request.answers[questionIndex]) ? request.answers[questionIndex] : [])
    if (selected.has(label)) selected.delete(label)
    else selected.add(label)
    request.answers[questionIndex] = [...selected]
    return false
  }
  request.answers[questionIndex] = [String(label)]
  request.completedQuestions[questionIndex] = true
  return true
}

export function completeOpenCodeQuestion(request, questionIndex, answer = null) {
  const question = request?.questions?.[questionIndex]
  if (!question) throw new Error("Question not found")
  request.answers ||= {}
  request.completedQuestions ||= {}
  if (answer !== null) request.answers[questionIndex] = [String(answer)]
  const answers = request.answers[questionIndex]
  if (!Array.isArray(answers) || !answers.length) throw new Error("Select or enter an answer first")
  request.completedQuestions[questionIndex] = true
}

export function openCodeQuestionAnswers(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  if (!questions.length || questions.some((_, index) => !request?.completedQuestions?.[index])) return null
  return questions.map((_, index) => Array.isArray(request.answers?.[index]) ? request.answers[index].map(String) : [])
}

export async function submitOpenCodeQuestion({ serverUrl, directory = "", requestId, action, answers = null, headers = {}, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!['reply', 'reject'].includes(action)) throw new Error("Unsupported OpenCode question action")
  const url = new URL(String(serverUrl))
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase())) throw new Error("Remote OpenCode endpoints are not allowed")
  url.pathname = `/question/${encodeURIComponent(String(requestId))}/${action}`
  url.search = new URLSearchParams({ directory }).toString()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const body = action === "reply" ? JSON.stringify({ answers }) : undefined
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {}),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.status === 204) return null
    const text = await response.text()
    return text ? JSON.parse(text) : null
  } finally {
    clearTimeout(timer)
  }
}
