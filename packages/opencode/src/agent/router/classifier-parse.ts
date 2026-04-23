import type { ClassifierOutput, AgentMode } from "./types"

export type ParseMode = "json-schema" | "json" | "regex"

export function parseClassifierOutput(raw: string, mode: ParseMode): ClassifierOutput {
  if (mode === "regex") return parseRegex(raw)
  return parseJson(raw)
}

function parseJson(raw: string): ClassifierOutput {
  let obj: unknown
  try { obj = JSON.parse(raw) }
  catch { throw new Error(`Classifier output is not valid JSON: ${raw.slice(0, 100)}`) }
  if (typeof obj !== "object" || obj === null) throw new Error("Classifier output is not a JSON object")
  const record = obj as Record<string, unknown>
  if (!record.decision || !["single", "coordinator"].includes(record.decision as string))
    throw new Error(`Invalid or missing 'decision' field: ${record.decision}`)
  if (!record.confidence || !["high", "low"].includes(record.confidence as string))
    throw new Error(`Invalid or missing 'confidence' field: ${record.confidence}`)
  const reason = typeof record.reason === "string" ? record.reason.slice(0, 80) : ""
  return { decision: record.decision as AgentMode, confidence: record.confidence as "high" | "low", reason }
}

function parseRegex(raw: string): ClassifierOutput {
  const decisionMatch = raw.match(/DECISION:\s*(single|coordinator)/i)
  const confidenceMatch = raw.match(/CONFIDENCE:\s*(high|low)/i)
  const reasonMatch = raw.match(/REASON:\s*(.+)/i)
  if (!decisionMatch) throw new Error("Missing DECISION in regex output")
  if (!confidenceMatch) throw new Error("Missing CONFIDENCE in regex output")
  return {
    decision: decisionMatch[1].toLowerCase() as AgentMode,
    confidence: confidenceMatch[1].toLowerCase() as "high" | "low",
    reason: (reasonMatch?.[1] ?? "").slice(0, 80),
  }
}
