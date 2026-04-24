import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Provider } from "../../../provider"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"
import { route } from "../../../agent/router"
import { RealWorkspaceAnalyzer } from "../../../agent/router/workspace-analyzer"
import { classifyArchetype, extractP1GlobMentions, extractP2PackageMentions, extractP3ScopeKeywords, extractP4ConjunctionChains, extractP5ExplicitPaths, computeCodebaseSignals, computeComposite } from "../../../agent/router/scorer"
import { buildClassifier, LAST_RESOLVED_MODEL, LAST_CLASSIFIER_ERROR } from "../../../agent/router/build-classifier"
import { withFaultyAnalyzer, withFaultyClassifier, getFaultMode } from "../../../agent/router/fault-inject"
import defaultWeights from "../../../agent/router/weights.json"
import type { RouterConfig } from "../../../agent/router/types"

/**
 * opencode debug router "<prompt>"
 *
 * Dry-run the auto-router on the given prompt without invoking any agent.
 * Prints the routing decision, fired signals, scores, and whether the
 * LLM tiebreaker would fire. Does NOT call an LLM by default (use --full
 * to actually invoke the tiebreaker in uncertain-band cases).
 *
 * Use this to:
 *   - Debug why a specific prompt routes to a particular mode
 *   - Validate routing decisions on real repos without running the agent
 *   - Compare decisions before/after weight tuning
 */
export const DebugRouterCommand = cmd({
  command: "router <prompt>",
  describe: "dry-run the auto-router on a prompt (no agent execution)",
  builder: (yargs) =>
    yargs
      .positional("prompt", {
        type: "string",
        demandOption: true,
        description: "User prompt to route",
      })
      .option("full", {
        type: "boolean",
        default: false,
        description: "Also invoke the LLM tiebreaker in uncertain-band cases (costs 1 small-model call)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        description: "Emit JSON output instead of formatted text",
      })
      .option("dir", {
        type: "string",
        description: "Workspace directory to analyze (default: current directory)",
      }),
  async handler(args) {
    const workspaceDir = (args.dir as string | undefined) ?? process.cwd()
    await bootstrap(workspaceDir, async () => {
      const prompt = args.prompt as string
      const full = args.full as boolean
      const json = args.json as boolean
      const config = defaultWeights as unknown as RouterConfig

      const faultMode = getFaultMode()
      if (faultMode && !json) process.stderr.write(`⚠ fault-inject active: ${faultMode}\n`)
      const analyzer = withFaultyAnalyzer(new RealWorkspaceAnalyzer())
      let analysis
      try {
        analysis = await analyzer.analyze(workspaceDir)
      } catch (e) {
        if (!json) process.stderr.write(`⚠ analyzer failed: ${(e as Error).message}\n`)
        // Empty fallback so downstream signal extraction + route() can still produce
        // a (fallback) decision. route() will hit the same error path via its own
        // analyzer call and return FALLBACK_DECISION.
        analysis = { totalFiles: 0, packageCount: 1, packages: [], languageCount: 0, manifestPaths: [], topLevelDirs: [] }
      }

      // Compute each signal individually for diagnostic output
      const p1 = extractP1GlobMentions(prompt)
      const p2 = extractP2PackageMentions(prompt, analysis.packages)
      const p3 = extractP3ScopeKeywords(prompt, config.scopeKeywords, config.mutationVerbs)
      const p4 = extractP4ConjunctionChains(prompt, config.mutationVerbs)
      const p5 = extractP5ExplicitPaths(prompt, analysis.topLevelDirs)
      const archetype = classifyArchetype(prompt, config.mutationVerbs)

      // Run the full router
      const classifier = full
        ? withFaultyClassifier(await AppRuntime.runPromise(
            Effect.gen(function* () {
              const providerSvc = yield* Provider.Service
              return yield* buildClassifier(providerSvc)
            }),
          ))
        : undefined

      if (full && !classifier && !json) {
        process.stderr.write("⚠ --full requested but no small model could be resolved. Tiebreaker will be skipped.\n")
        process.stderr.write("  Check: no provider has a small model matching [claude-haiku, gpt-5-nano, gemini-flash].\n")
      }
      if (full && classifier && !json) {
        const m = LAST_RESOLVED_MODEL
        if (m) process.stderr.write(`  Tiebreaker will use: ${m.providerID}/${m.modelID}\n`)
      }

      const decision = await route({
        prompt,
        workspaceRoot: workspaceDir,
        cwd: workspaceDir,
        modelId: "",
        analyzer,
        classifier,
      })

      const cSignals = computeCodebaseSignals(analysis, decision.firedSignals.includes("P2_package_mentions") ? analysis.packages.filter(p => extractP2PackageMentions(prompt, [p]) > 0) : [])
      const composite = computeComposite(decision.signals.promptScore, decision.signals.codebaseScore)

      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              prompt,
              workspace: { root: workspaceDir, totalFiles: analysis.totalFiles, packageCount: analysis.packageCount, languageCount: analysis.languageCount },
              signals: { p1, p2, p3, p4, p5, archetype, codebase: cSignals },
              firedSignals: decision.firedSignals,
              scores: { prompt: decision.signals.promptScore, codebase: decision.signals.codebaseScore, primary: composite.primary, secondary: composite.secondary },
              decision: { mode: decision.mode, confidence: decision.confidence, reason: decision.reason },
              tiebreaker: { invokedInThisRun: full, wouldFire: composite.primary >= config.bands.leanSingleMax && composite.primary < config.bands.uncertainMax, actuallyUsed: decision.signals.llmTiebreakerUsed },
              fallbackPath: decision.fallbackPath,
            },
            null,
            2,
          ) + "\n",
        )
        return
      }

      // Pretty-printed output
      const line = (s: string = "") => process.stdout.write(s + "\n")
      line()
      line(`Routing decision: ${decision.mode} (${decision.confidence} confidence)`)
      line(`Reason: ${decision.reason}`)
      line()
      line(`Workspace:`)
      line(`  Root: ${workspaceDir}`)
      line(`  Files: ${analysis.totalFiles}`)
      line(`  Packages: ${analysis.packageCount} — ${analysis.packages.slice(0, 5).join(", ")}${analysis.packages.length > 5 ? ", ..." : ""}`)
      line(`  Languages: ${analysis.languageCount}`)
      line()
      line(`Prompt signals:`)
      line(`  P1 glob_mentions     = ${p1}`)
      line(`  P2 package_mentions  = ${p2}`)
      line(`  P3 scope_keywords    = ${p3}`)
      line(`  P4 conjunction_chain = ${p4}`)
      line(`  P5 explicit_paths    = ${p5}`)
      line(`  P6 archetype         = ${archetype}`)
      line()
      line(`Codebase signals:`)
      line(`  C1 total_files       = ${cSignals.C1}`)
      line(`  C2 package_count     = ${cSignals.C2}`)
      line(`  C3 affected_subset   = ${cSignals.C3}`)
      line(`  C4 cross_package     = ${cSignals.C4}`)
      line(`  C5 multi_language    = ${cSignals.C5}`)
      line()
      line(`Fired signals (contributed to the decision):`)
      for (const s of decision.firedSignals) line(`  • ${s}`)
      line()
      line(`Scores (normalized to [0,10]):`)
      line(`  promptScore   = ${decision.signals.promptScore.toFixed(2)}`)
      line(`  codebaseScore = ${decision.signals.codebaseScore.toFixed(2)}`)
      line(`  primaryScore  = ${composite.primary.toFixed(2)}  ← band applied to this (AND-gate: min)`)
      line(`  secondaryScore= ${composite.secondary.toFixed(2)}  (tiebreaker context only)`)
      line()
      line(`Bands: strong-single [0, ${config.bands.strongSingleMax}) | lean-single [${config.bands.strongSingleMax}, ${config.bands.leanSingleMax}) | uncertain [${config.bands.leanSingleMax}, ${config.bands.uncertainMax}) | lean-coordinator [${config.bands.uncertainMax}, ${config.bands.leanCoordinatorMax}) | strong-coordinator [${config.bands.leanCoordinatorMax}, 10]`)
      line()
      if (decision.signals.llmTiebreakerUsed) {
        line(`Tiebreaker: INVOKED (latency ${decision.signals.llmTiebreakerLatencyMs}ms)`)
      } else if (composite.primary >= config.bands.leanSingleMax && composite.primary < config.bands.uncertainMax) {
        if (!full) {
          line(`Tiebreaker: would invoke (use --full to actually call the LLM)`)
        } else if (!classifier) {
          line(`Tiebreaker: attempted but no small model was available`)
        } else {
          line(`Tiebreaker: invoked but failed${LAST_CLASSIFIER_ERROR ? " — " + LAST_CLASSIFIER_ERROR : ""}`)
        }
      } else {
        line(`Tiebreaker: not needed (decision is clearly ${decision.mode})`)
      }
      if (decision.fallbackPath) line(`Fallback path: ${decision.fallbackPath}`)
      line()
    })
  },
})
