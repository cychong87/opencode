export type AgentMode = "single" | "coordinator"
export type Confidence = "high" | "medium" | "low"
export type TaskArchetype = "mutating-broad" | "mutating-narrow" | "read-only" | "trivial"
export type DecisionSource = "routed" | "inherited" | "override"

export interface RouteInput {
  prompt: string
  workspaceRoot: string
  cwd: string
  modelId: string
  sessionHistory?: {
    previousDecision?: RoutingDecision
    turnIndex: number
  }
  analyzer: WorkspaceAnalyzer
  classifier?: LLMClassifier
  config?: RouterConfig
}

export interface RoutingDecision {
  mode: AgentMode
  reason: string
  confidence: Confidence
  confidenceScore: number
  firedSignals: string[]
  suggestedWorkerCount?: number
  suggestedPartition?: string[][]
  signals: {
    promptScore: number
    codebaseScore: number
    llmTiebreakerUsed: boolean
    llmTiebreakerLatencyMs?: number
  }
  decidedAt: number
  workspaceFingerprint: string
  fallbackPath: string | null
}

export interface WorkspaceAnalysis {
  totalFiles: number
  packageCount: number
  packages: string[]
  languageCount: number
  manifestPaths: string[]
  topLevelDirs: string[]
}

export interface WorkspaceAnalyzer {
  analyze(workspaceRoot: string): Promise<WorkspaceAnalysis>
}

export interface ClassifierInput {
  prompt: string
  firedSignalNames: string[]
  heuristicSummary: {
    taskArchetype: TaskArchetype
    fileCount: number
    packageCount: number
  }
  timeoutMs: number
}

export interface ClassifierOutput {
  decision: AgentMode
  confidence: "high" | "low"
  reason: string
}

export interface LLMClassifier {
  classify(input: ClassifierInput): Promise<ClassifierOutput>
}

export interface RouterConfig {
  weightsVersion: string
  promptSignalWeights: Record<string, number>
  codebaseSignalWeights: Record<string, number>
  bands: {
    strongSingleMax: number
    leanSingleMax: number
    uncertainMax: number
    leanCoordinatorMax: number
  }
  tiebreaker: TiebreakerConfig
  mutationVerbs: string[]
  scopeKeywords: string[]
}

export interface TiebreakerConfig {
  enabled: boolean
  modelRef: string | null
  timeoutMs: number
  maxTokens: number
  maxCallsPerSession: number
  circuitBreaker: {
    consecutiveFailuresToTrip: number
    cooldownMs: number
  }
}

export interface HintBlock {
  suggestedWorkerCount?: number
  suggestedPartition?: string[][]
  triggerReasons: string[]
}

export interface TelemetryRecord {
  ts: string
  sessionId: string
  turnIndex: number
  source: DecisionSource
  promptSha: string
  workspaceFingerprint: string
  routerDecisionVersion: string
  firedSignalNames: string[]
  taskArchetype: TaskArchetype
  scores: { prompt: number; codebase: number; primary: number; secondary: number }
  classifier: {
    invoked: boolean
    modelRef?: string
    latencyMs?: number
    outcome?: string
    failureMode: string | null
  }
  finalDecision: { mode: AgentMode; confidence: Confidence }
  fallbackPath: string | null
}
