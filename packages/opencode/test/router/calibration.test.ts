import { describe, test, expect } from "bun:test"
import { route } from "@/agent/router"
import { FakeWorkspaceAnalyzer } from "@/agent/router/workspace-analyzer"
import type { WorkspaceAnalysis } from "@/agent/router/types"
import fixture from "@/agent/router/fixtures/calibration.json"
import gate from "@/agent/router/gate.json"

// Workspace analysis for each fixture workspace name
const workspaceMap: Record<string, WorkspaceAnalysis> = {
  "empty": {
    totalFiles: 0, packageCount: 1, packages: [],
    languageCount: 0, manifestPaths: [], topLevelDirs: [],
  },
  "single-pkg": {
    totalFiles: 6, packageCount: 1, packages: ["my-app"],
    languageCount: 1, manifestPaths: ["package.json"], topLevelDirs: ["src"],
  },
  "monorepo-small": {
    totalFiles: 15, packageCount: 3,
    packages: ["packages/auth", "packages/api", "packages/shared"],
    languageCount: 1,
    manifestPaths: ["package.json", "packages/auth/package.json", "packages/api/package.json", "packages/shared/package.json"],
    topLevelDirs: ["packages", "scripts"],
  },
  "polyglot": {
    totalFiles: 8, packageCount: 2, packages: ["frontend", "backend"],
    languageCount: 2,
    manifestPaths: ["frontend/package.json", "backend/pyproject.toml"],
    topLevelDirs: ["frontend", "backend"],
  },
  "with-nodemodules": {
    totalFiles: 2, packageCount: 1, packages: ["my-app"],
    languageCount: 1, manifestPaths: ["package.json"], topLevelDirs: ["src"],
  },
}

function wilsonLCB(successes: number, trials: number, z = 1.96): number {
  if (trials === 0) return 0
  const p = successes / trials
  const denom = 1 + z * z / trials
  return (p + z * z / (2 * trials) - z * Math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials))) / denom
}

describe("Calibration", () => {
  test("router precision and recall meet gate thresholds", async () => {
    let tp = 0, fp = 0, fn = 0, tn = 0
    const misrouted: string[] = []

    for (const entry of (fixture as any).prompts) {
      const analysis = workspaceMap[entry.workspace]
      if (!analysis) throw new Error(`Unknown workspace fixture: ${entry.workspace}`)

      const decision = await route({
        prompt: entry.prompt,
        workspaceRoot: "/fake",
        cwd: "/fake",
        modelId: "test",
        analyzer: new FakeWorkspaceAnalyzer(analysis),
      })

      const predicted = decision.mode
      const expected = entry.expected

      if (predicted === "coordinator" && expected === "coordinator") tp++
      else if (predicted === "coordinator" && expected === "single") {
        fp++
        misrouted.push(`FP: "${entry.prompt}" [${entry.workspace}] → ${predicted} (expected ${expected}) | reason: ${decision.reason}`)
      }
      else if (predicted === "single" && expected === "coordinator") {
        fn++
        misrouted.push(`FN: "${entry.prompt}" [${entry.workspace}] → ${predicted} (expected ${expected}) | reason: ${decision.reason}`)
      }
      else tn++
    }

    const precision = tp / Math.max(1, tp + fp)
    const recall = tp / Math.max(1, tp + fn)
    const f1 = 2 * precision * recall / Math.max(0.001, precision + recall)

    // Print results for diagnostic
    console.log(`\nCalibration results: P=${precision.toFixed(3)} R=${recall.toFixed(3)} F1=${f1.toFixed(3)}`)
    console.log(`  TP=${tp} FP=${fp} FN=${fn} TN=${tn} (total=${tp+fp+fn+tn})`)
    if (misrouted.length > 0) {
      console.log(`  Misrouted (${misrouted.length}):`)
      for (const m of misrouted) console.log(`    ${m}`)
    }

    const precisionLCB = wilsonLCB(tp, tp + fp)
    const recallLCB = wilsonLCB(tp, tp + fn)

    console.log(`  Wilson LCB: precision=${precisionLCB.toFixed(3)} recall=${recallLCB.toFixed(3)}`)
    console.log(`  Gate: precision>=${gate.precision} recall>=${gate.recall} f1>=${gate.f1}`)

    expect(precisionLCB).toBeGreaterThanOrEqual(gate.precision)
    expect(recallLCB).toBeGreaterThanOrEqual(gate.recall)
    expect(f1).toBeGreaterThanOrEqual(gate.f1)
  })
})
