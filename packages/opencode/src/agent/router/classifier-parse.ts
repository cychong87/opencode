import type { ClassifierOutput, AgentMode } from "./types"

export type ParseMode = "json-schema" | "json" | "regex"

export function parseClassifierOutput(raw: string, mode: ParseMode): ClassifierOutput {
  if (mode === "regex") return parseRegex(raw)
  return parseJson(raw)
}

function parseJson(raw: string): ClassifierOutput {
  // Real LLMs often wrap JSON in markdown fences or prose. Extract the JSON object
  // before parsing so we're lenient to common output shapes:
  //   ```json\n{...}\n```
  //   Here is the result: {...}
  //   {...} \n Hope this helps!
  const extracted = extractJsonObject(raw) ?? raw
  let obj: unknown
  try { obj = JSON.parse(extracted) }
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

/**
 * Extract the first balanced JSON object from a string. Handles:
 *   - Markdown fences: ```json {...} ```
 *   - Leading/trailing prose: "Here is the answer: {...}"
 *   - Returns null if no balanced { ... } is found.
 */
function extractJsonObject(raw: string): string | null {
  // Strip markdown fences first
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(raw)
  if (fenced) return fenced[1]

  // Balanced-brace extraction, respecting strings
  const start = raw.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) { escape = false; continue }
    if (ch === "\\") { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
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
