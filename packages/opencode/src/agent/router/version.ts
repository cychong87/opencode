import { createHash } from "crypto"
import weights from "./weights.json"

// Compile-time router version. Bump when route() interface or core logic changes.
export const ROUTER_VERSION = "v0.2.0"

// Weights version from config (bumped when weights.json changes meaningfully).
export const WEIGHTS_VERSION: string = weights.weightsVersion

// Compute routerDecisionVersion = sha256(router || weights || tiebreakerPromptSha).slice(0,12)
// This hash tags each telemetry record so calibration can segregate data across versions.
// The tiebreakerPromptSha is passed in (not hashed here) so this module stays side-effect-free.
export function computeRouterDecisionVersion(tiebreakerPromptSha: string): string {
  const input = `${ROUTER_VERSION}|${WEIGHTS_VERSION}|${tiebreakerPromptSha}`
  return createHash("sha256").update(input).digest("hex").slice(0, 12)
}

// SHA-256 of any string (used to hash prompts for privacy-preserving telemetry).
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}
