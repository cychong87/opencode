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

  // 4. Extract prompt signals (P1–P5)
  const p1 = extractP1GlobMentions(input.prompt)
  const p2 = extractP2PackageMentions(input.prompt, analysis.packages)
  const p3 = extractP3ScopeKeywords(input.prompt, config.scopeKeywords, config.mutationVerbs)
  const p4 = extractP4ConjunctionChains(input.prompt, config.mutationVerbs)
  const p5 = extractP5ExplicitPaths(input.prompt, analysis.topLevelDirs)

  // P6: read-only archetype modifier (-1.0 when archetype is read-only)
  const archetype = classifyArchetype(input.prompt, config.mutationVerbs)
  const p6Raw = archetype === "read-only" ? 1 : 0

  const pw = config.promptSignalWeights
  const promptRawScore =
    p1 * (pw["P1_glob_mentions"] ?? 1) +
    p2 * (pw["P2_package_mentions"] ?? 1) +
    p3 * (pw["P3_scope_keywords"] ?? 1) +
    p4 * (pw["P4_conjunction_chains"] ?? 1) +
    p5 * (pw["P5_explicit_path_count"] ?? 0.5) +
    p6Raw * (pw["P6_read_only_modifier"] ?? -1.0)

  const promptScore = Math.max(0, promptRawScore)

  // Build fired signals list
  const firedSignals: string[] = []
  if (p1 > 0) firedSignals.push("P1_glob_mentions")
  if (p2 > 0) firedSignals.push("P2_package_mentions")
  if (p3 > 0) firedSignals.push("P3_scope_keywords")
  if (p4 > 0) firedSignals.push("P4_conjunction_chains")
  if (p5 > 0) firedSignals.push("P5_explicit_path_count")
  if (p6Raw > 0) firedSignals.push("P6_read_only_modifier")

  // 5. Compute codebase signals (C1–C5)
  // mentionedPackages = packages that fired in P2
  const mentionedPackages = analysis.packages.filter(pkg => {
    if (pkg.startsWith("@")) return input.prompt.includes(pkg)
    const re = new RegExp(`\\b${escapeRegex(pkg)}\\b`)
    return re.test(input.prompt)
  })

  const codebaseSignals = computeCodebaseSignals(analysis, mentionedPackages)

  const cw = config.codebaseSignalWeights
  const codebaseScore =
    codebaseSignals.C1 * (cw["C1_total_files"] ?? 1) +
    codebaseSignals.C2 * (cw["C2_package_count"] ?? 1) +
    codebaseSignals.C3 * (cw["C3_affected_subset_size"] ?? 1) +
    codebaseSignals.C4 * (cw["C4_cross_package_breadth"] ?? 2) +
    codebaseSignals.C5 * (cw["C5_multilanguage"] ?? 1)

  if (codebaseSignals.C1 > 0) firedSignals.push("C1_total_files")
  if (codebaseSignals.C2 > 0) firedSignals.push("C2_package_count")
  if (codebaseSignals.C3 > 0) firedSignals.push("C3_affected_subset_size")
  if (codebaseSignals.C4 > 0) firedSignals.push("C4_cross_package_breadth")
  if (codebaseSignals.C5 > 0) firedSignals.push("C5_multilanguage")

  // 6. Compute composite scores
  // primary = min(promptScore, codebaseScore) — used for floor rule check
  // secondary = 0.6*prompt + 0.4*codebase — used for band decision
  const composite = computeComposite(promptScore, codebaseScore)

  // 8. Apply decision bands using secondary score
  const bandResult = applyDecisionBand(composite.secondary, config.bands)

  // 7. Apply floor rules (uses promptScore and C3 as min-gates)
  // Floor rule can override band result to force single, but if band already
  // gives single, preserve band's confidence (e.g. high).
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
    reason: `band:${bandResult.mode}`,
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
