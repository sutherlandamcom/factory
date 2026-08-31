/**
 * Autonomy v0 evaluation contracts (INTERNAL to the evals module — never
 * production runtime). Hand-rolled bounded validators keep apps/factory free
 * of direct schema-library dependencies: strict validation of model and
 * judge output is done by small deterministic parsers that fail closed.
 */

/** Bounded content draft produced by content_writer candidates. */
export interface ContentDraft {
  heading: string;
  body: string;
  ctaJob: string;
}

/** Bounded design direction proposal produced by design_director candidates. */
export interface DesignSpecDraft {
  visualCharacter: string;
  density: string;
  typographyMood: string;
  colorMood: string;
  imageryPolicy: string;
  ctaTreatment: string;
  paletteNote: string;
}

export const EVAL_ROLE_IDS = [
  "site_intelligence",
  "blueprint_architect",
  "content_writer",
  "design_director",
] as const;

export type EvalRoleId = (typeof EVAL_ROLE_IDS)[number];

export type JudgeLabel = "A" | "B" | "C";

export interface JudgeDimensionScores {
  grounding: number;
  usefulness: number;
  restraint: number;
  accuracy: number;
  quality: number;
}

export interface JudgeVerdict {
  scores: Record<JudgeLabel, JudgeDimensionScores | undefined>;
  preferred: JudgeLabel;
  rationale: string;
}

export interface EvalCandidateSummary {
  label: JudgeLabel;
  family: "openai" | "anthropic" | "google";
  model: string;
  respondedModel: string | null;
  provider: string | null;
  schemaValid: boolean;
  deterministicValid: boolean;
  issueCount: number;
  firstIssue: string | null;
  outputDigest: string | null;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  invocationError: string | null;
}

export interface EvalJudgeSummary {
  model: string;
  verdict: JudgeVerdict | null;
  error: string | null;
}

export interface EvalWinner {
  label: JudgeLabel;
  model: string;
  deterministicValid: boolean;
  averageRubric: number;
  preferenceVotes: number;
}

export interface EvalResult {
  version: "v0";
  status: "succeeded" | "failed";
  runId: string;
  roleId: string;
  inputDigests: Record<string, string>;
  candidates: EvalCandidateSummary[];
  judges: EvalJudgeSummary[];
  winner: EvalWinner | null;
  totalCostUsd: number;
  budgetUsdCap: number;
  warnings: string[];
  error: { code: string; message: string } | null;
}

// ---------------------------------------------------------------------------
// Strict bounded parsers (fail closed; no unknown fields, no salvage)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function boundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.trim().length <= max;
}

const CONTENT_DRAFT_KEYS = ["heading", "body", "ctaJob"] as const;

/** Strict parse of a ContentDraft; throws on any deviation. */
export function parseContentDraft(input: unknown): ContentDraft {
  if (!isRecord(input) || !exactKeys(input, CONTENT_DRAFT_KEYS)) {
    throw new Error("content draft must be an object with exactly heading, body, ctaJob");
  }
  if (!boundedText(input.heading, 1, 200)) throw new Error("heading must be 1-200 chars");
  if (!boundedText(input.body, 200, 4000)) throw new Error("body must be 200-4000 chars");
  if (!boundedText(input.ctaJob, 1, 200)) throw new Error("ctaJob must be 1-200 chars");
  return { heading: input.heading.trim(), body: input.body.trim(), ctaJob: input.ctaJob.trim() };
}

const DESIGN_DRAFT_KEYS = [
  "visualCharacter",
  "density",
  "typographyMood",
  "colorMood",
  "imageryPolicy",
  "ctaTreatment",
  "paletteNote",
] as const;

/** Strict parse of a DesignSpecDraft; throws on any deviation. */
export function parseDesignSpecDraft(input: unknown): DesignSpecDraft {
  if (!isRecord(input) || !exactKeys(input, DESIGN_DRAFT_KEYS)) {
    throw new Error(`design draft must be an object with exactly ${DESIGN_DRAFT_KEYS.join(", ")}`);
  }
  const fields = [
    ["visualCharacter", 1, 400],
    ["density", 1, 100],
    ["typographyMood", 1, 200],
    ["colorMood", 1, 200],
    ["imageryPolicy", 1, 300],
    ["ctaTreatment", 1, 200],
    ["paletteNote", 1, 300],
  ] as const;
  for (const [key, min, max] of fields) {
    if (!boundedText(input[key], min, max)) {
      throw new Error(`${key} must be ${min}-${max} chars`);
    }
  }
  return Object.fromEntries(fields.map(([key]) => [key, (input[key] as string).trim()])) as unknown as DesignSpecDraft;
}

const JUDGE_KEYS = ["scores", "preferred", "rationale"] as const;
const SCORE_KEYS = ["grounding", "usefulness", "restraint", "accuracy", "quality"] as const;
const LABELS = ["A", "B", "C"] as const;

function parseDimensionScores(value: unknown): JudgeDimensionScores {
  if (!isRecord(value) || !exactKeys(value, SCORE_KEYS)) {
    throw new Error(`scores must contain exactly ${SCORE_KEYS.join(", ")}`);
  }
  const result = {} as JudgeDimensionScores;
  for (const key of SCORE_KEYS) {
    const raw = value[key];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 5) {
      throw new Error(`${key} must be an integer 1-5`);
    }
    result[key] = raw;
  }
  return result;
}

/** Strict parse of a blind judge verdict; throws on any deviation. */
export function parseJudgeVerdict(input: unknown): JudgeVerdict {
  if (!isRecord(input) || !exactKeys(input, JUDGE_KEYS)) {
    throw new Error("judge verdict must be an object with exactly scores, preferred, rationale");
  }
  if (!isRecord(input.scores)) throw new Error("scores must be an object keyed by A/B/C");
  const scores: Record<JudgeLabel, JudgeDimensionScores | undefined> = { A: undefined, B: undefined, C: undefined };
  for (const label of LABELS) {
    const entry = input.scores[label];
    if (entry !== undefined) {
      scores[label] = parseDimensionScores(entry);
    }
  }
  if (!scores.A && !scores.B && !scores.C) {
    throw new Error("scores must contain at least one candidate");
  }
  if (input.preferred !== "A" && input.preferred !== "B" && input.preferred !== "C") {
    throw new Error("preferred must be A, B, or C");
  }
  if (!boundedText(input.rationale, 1, 2000)) throw new Error("rationale must be 1-2000 chars");
  return { scores, preferred: input.preferred, rationale: input.rationale.trim() };
}
