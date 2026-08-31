/**
 * Factory site-intelligence module (protected; not ordinary-task writable).
 *
 * First-Site Intelligence vertical slice: bounded evidence in, strict
 * provenance-aware launch plan out, compiled deterministically into the
 * existing create_page SiteTask contract.
 */
export { SYNTHESIS_TIMEOUT_MS, resolveFactorySourceCommit, runIntelligence } from "./driver.js";
export type {
  FactorySourceCommitInfo,
  RunIntelligenceDeps,
  RunIntelligenceInput,
  SourceCommitResolver,
} from "./driver.js";
export { canonicalJsonStringify, deterministicDigest, sha256Hex } from "./digest.js";
export { countDuplicateEvidenceRecords, normalizeResearchBundle, normalizeUrlForComparison } from "./normalize.js";
export { buildSynthesisPrompt, buildSynthesisRepairPrompt } from "./prompt.js";
export { validateSiteIntelligencePlan } from "./plan-validation.js";
export type { PlanValidationInput, PlanValidationResult } from "./plan-validation.js";
export { compilePlanToTasks } from "./compile.js";
export type { CompiledIntelligenceTask } from "./compile.js";
export {
  RUN_ID_PATTERN,
  buildArtifactDigests,
  generateRunId,
  intelligenceRunDirectory,
  prepareRunDirectory,
  publishJsonAtomically,
  randomRunIdSuffix,
  verifyArtifactIntegrity,
  writeArtifact,
} from "./artifacts.js";
export {
  intelligenceWorkspacePath,
  parseModelPlanOutput,
  parseModelRuntimeFromStdout,
  prepareSynthesisWorkspace,
  removeSynthesisWorkspace,
  runSynthesisAttempt,
} from "./synthesis.js";
export type { ModelOutputParseResult, SynthesisAttemptResult, SynthesisWorkspace } from "./synthesis.js";
