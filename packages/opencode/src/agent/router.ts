import type {
  RouteInput,
  RoutingDecision,
  RouterConfig,
  ClassifierInput,
  ClassifierOutput,
  WorkspaceAnalysis,
} from "./router/types"
import {
  extractP1GlobMentions,
  extractP2PackageMentions,
  extractP3ScopeKeywords,
  extractP4ConjunctionChains,
  extractP5ExplicitPaths,
  classifyArchetype,
  computeCodebaseSignals,
  computeComposite,
  applyDecisionBand,
  applyFloorRules,
} from "./router/scorer"
import { computeFingerprint } from "./router/fingerprint"
import defaultWeights from "./router/weights.json"

const FALLBACK_DECISION: RoutingDecision = {
  mode: "single",
  confidence: "low",
  confidenceScore: 0.1,
  reason: "router fallback",
  firedSignals: [],
  signals: { promptScore: 0, codebaseScore: 0, llmTiebreakerUsed: false },
  decidedAt: 0,
  workspaceFingerprint: "",
  fallbackPath: "router_error",
}

export async function route(input: RouteInput): Promise<RoutingDecision> {
  try {
    return await _route(input)
  } catch {
    return { ...FALLBACK_DECISION, decidedAt: Date.now() }
  }
}

async function _route(input: RouteInput): Promise<RoutingDecision> {
  // 1. Load config (use input.config or default weights)
  const config = (input.config ?? defaultWeights) as RouterConfig

  // 2. Run workspace analysis
  const analysis: WorkspaceAnalysis = await input.analyzer.analyze(input.workspaceRoot)

  // 3. Compute fingerprint
  let fingerprint = ""
  try {
    fingerprint = await computeFingerprint(input.workspaceRoot)
  } catch {
    // Fingerprint failure is non-fatal; leave as empty string
    fingerprint = ""
  }

  // 4. Extract prompt signals (P1–P6)
  const p1 = extractP1GlobMentions(input.prompt)
  const p2 = extractP2PackageMentions(input.prompt, analysis.packages)
  const p3 = extractP3ScopeKeywords(input.prompt, config.scopeKeywords, config.mutationVerbs)
  const p4 = extractP4ConjunctionChains(input.prompt, config.mutationVerbs)
  const p5 = extractP5ExplicitPaths(input.prompt, analysis.topLevelDirs)
  const archetype = classifyArchetype(input.prompt, config.mutationVerbs)
  const p6Modifier = archetype === "read-only" ? -1.0 : 0

  // Normalize each signal to [0,1], multiply by weight, sum, scale to [0,10]
  // Caps: P1=3, P2=4, P3=3, P4=3, P5=4
  const pw = config.promptSignalWeights
  const promptWeightedSum =
    (p1 / 3) * (pw["P1_glob_mentions"] ?? 1) +
    (p2 / 4) * (pw["P2_package_mentions"] ?? 1) +
    (p3 / 3) * (pw["P3_scope_keywords"] ?? 1) +
    (p4 / 3) * (pw["P4_conjunction_chains"] ?? 1) +
    (p5 / 4) * (pw["P5_explicit_path_count"] ?? 0.5)
  // Max possible weighted sum (all signals at cap): 1+1+1+1+0.5 = 4.5
  const maxPromptSum = 1 + 1 + 1 + 1 + 0.5
  const promptScore = Math.max(0, (promptWeightedSum / maxPromptSum) * 10 + p6Modifier)

  // Build fired signals list
  const firedSignals: string[] = []
  if (p1 > 0) firedSignals.push("P1_glob_mentions")
  if (p2 > 0) firedSignals.push("P2_package_mentions")
  if (p3 > 0) firedSignals.push("P3_scope_keywords")
  if (p4 > 0) firedSignals.push("P4_conjunction_chains")
  if (p5 > 0) firedSignals.push("P5_explicit_path_count")
  if (archetype === "read-only") firedSignals.push("P6_read_only_modifier")

  // 5. Compute codebase signals (C1–C5)
  // Reuse P2's matched packages (respects noise-reduction rules)
  const mentionedPackages = analysis.packages.filter(pkg =>
    extractP2PackageMentions(input.prompt, [pkg]) > 0
  )

  const codebaseSignals = computeCodebaseSignals(analysis, mentionedPackages)

  // Normalize each codebase signal to [0,1], multiply by weight, sum, scale to [0,10]
  const cw = config.codebaseSignalWeights
  const codebaseWeightedSum =
    (codebaseSignals.C1 / 3) * (cw["C1_total_files"] ?? 1) +
    (codebaseSignals.C2 / 3) * (cw["C2_package_count"] ?? 1) +
    (codebaseSignals.C3 / 3) * (cw["C3_affected_subset_size"] ?? 1) +
    (codebaseSignals.C4 / 2) * (cw["C4_cross_package_breadth"] ?? 2) +
    (codebaseSignals.C5 / 1) * (cw["C5_multilanguage"] ?? 1)
  // Max possible: 1+1+1+2+1 = 6
  const maxCodebaseSum = 1 + 1 + 1 + 2 + 1
  const codebaseScore = (codebaseWeightedSum / maxCodebaseSum) * 10

  if (codebaseSignals.C1 > 0) firedSignals.push("C1_total_files")
  if (codebaseSignals.C2 > 0) firedSignals.push("C2_package_count")
  if (codebaseSignals.C3 > 0) firedSignals.push("C3_affected_subset_size")
  if (codebaseSignals.C4 > 0) firedSignals.push("C4_cross_package_breadth")
  if (codebaseSignals.C5 > 0) firedSignals.push("C5_multilanguage")

  // 6. Composite: primary = min (AND-gate), secondary = weighted blend (tiebreaker context)
  const composite = computeComposite(promptScore, codebaseScore)

  // 7. Apply decision bands to PRIMARY score (spec §4: AND-gate)
  const bandResult = applyDecisionBand(composite.primary, config.bands)

  // 8. Apply floor rules — can override band to force single
  const floorResult = applyFloorRules(archetype, codebaseSignals, promptScore)
  if (floorResult === "single" && bandResult.mode !== "single") {
    // Floor rule is actually overriding a non-single decision
    return {
      mode: "single",
      confidence: archetype === "read-only" ? "high" : "medium",
      confidenceScore: archetype === "read-only" ? 0.9 : 0.6,
      reason: archetype === "read-only" ? "floor_rule:read_only" : "floor_rule:min_gate",
      firedSignals,
      signals: { promptScore, codebaseScore, llmTiebreakerUsed: false },
      decidedAt: Date.now(),
      workspaceFingerprint: fingerprint,
      fallbackPath: null,
    }
  }

  let finalMode = bandResult.mode
  let finalConfidence = bandResult.confidence
  let llmTiebreakerUsed = false
  let llmTiebreakerLatencyMs: number | undefined

  // 9. Optionally fire LLM tiebreaker (uncertain band + classifier provided)
  if (bandResult.mode === "uncertain" && input.classifier) {
    const tiebreakerStart = Date.now()
    let classifierOutput: ClassifierOutput | null = null

    try {
      const classifierInput: ClassifierInput = {
        prompt: input.prompt,
        firedSignalNames: firedSignals,
        heuristicSummary: {
          taskArchetype: archetype,
          fileCount: analysis.totalFiles,
          packageCount: analysis.packageCount,
        },
        timeoutMs: config.tiebreaker.timeoutMs,
      }
      const raw = await input.classifier.classify(classifierInput)
      classifierOutput = raw as ClassifierOutput | null
    } catch {
      classifierOutput = null
    }

    llmTiebreakerLatencyMs = Date.now() - tiebreakerStart

    if (classifierOutput !== null) {
      llmTiebreakerUsed = true

      // 10. Resolve classifier output per mapping:
      // coordinator + high confidence → coordinator, medium
      // coordinator + low confidence → single, low (conservative)
      // single + high confidence → single, medium
      // single + low confidence → single, low
      const clsDec = classifierOutput.decision
      const clsConf = classifierOutput.confidence

      if (clsDec === "coordinator" && clsConf === "high") {
        finalMode = "coordinator"
        finalConfidence = "medium"
      } else if (clsDec === "coordinator" && clsConf === "low") {
        finalMode = "single"
        finalConfidence = "low"
      } else if (clsDec === "single" && clsConf === "high") {
        finalMode = "single"
        finalConfidence = "medium"
      } else {
        // single + low
        finalMode = "single"
        finalConfidence = "low"
      }
    }
  }

  // For non-uncertain bands, coerce mode to single/coordinator
  if (finalMode === "uncertain") {
    // Tiebreaker skipped or returned null — default to single/low
    finalMode = "single"
    finalConfidence = "low"
  }

  // Compute a confidence score in [0,1] from confidence string
  const confidenceScore =
    finalConfidence === "high" ? 0.9 :
    finalConfidence === "medium" ? 0.6 :
    0.3

  // 11. Return RoutingDecision
  return {
    mode: finalMode as "single" | "coordinator",
    confidence: finalConfidence,
    confidenceScore,
    reason: buildReason(finalMode as "single" | "coordinator", firedSignals, analysis, archetype),
    firedSignals,
    signals: {
      promptScore,
      codebaseScore,
      llmTiebreakerUsed,
      ...(llmTiebreakerLatencyMs !== undefined ? { llmTiebreakerLatencyMs } : {}),
    },
    decidedAt: Date.now(),
    workspaceFingerprint: fingerprint,
    fallbackPath: null,
  }
}

function buildReason(
  mode: "single" | "coordinator",
  firedSignals: string[],
  analysis: WorkspaceAnalysis,
  archetype: string,
): string {
  if (archetype === "read-only") return "read-only task"
  if (mode === "single") {
    if (analysis.packageCount <= 1) return "single-package edit"
    return "single-agent sufficient"
  }
  // Coordinator — describe why
  const parts: string[] = []
  if (firedSignals.includes("C4_cross_package_breadth"))
    parts.push(`${analysis.packageCount} packages`)
  if (analysis.totalFiles > 0)
    parts.push(`${analysis.totalFiles} files`)
  if (parts.length > 0) return parts.join(", ")
  return "complex parallel task"
}

