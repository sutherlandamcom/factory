/**
 * MERGE PILOT AUTHORITY GUARD (P0-01) — runtime TEST-ONLY authority.
 *
 * Declared constants (`publicationAuthority: false`, `scope: "test_project_only"`)
 * were found NOT to enforce anything at runtime. This guard is the ONLY way
 * to obtain pilot execution authority: it resolves an opaque, symbol-marked
 * grant from the durable registry (merge_pilot_profiles / merge_pilot_runs)
 * or refuses with a typed error BEFORE any budget reservation or network
 * call.
 *
 * Hard rules enforced here:
 * - Env may only REQUEST the pilot and NARROW its budget; it can never grant
 *   authority (project binding, revocation, run binding live in the DB).
 * - Authority is bound to (projectId, profileVersion, role, runId) exactly.
 * - publicationAuthority is `false` by construction: pilot artifacts are
 *   labelled pilot_no_publication downstream and can never pass production
 *   approval, release approval, or publication gates.
 * - Existing governance (human approval, claim lineage, digests, design and
 *   production QA) is NOT relaxed: the pilot adds a gate, it never removes
 *   one.
 */
import { deterministicDigest } from "../intelligence/digest.js";
import { FactoryError } from "../executor/errors.js";
import {
  MERGE_PILOT_ALLOWED_ROLES,
  MERGE_PILOT_BUDGET_LIMIT_MICROS,
  MERGE_PILOT_MODEL,
  MERGE_PILOT_PROVIDER,
  MERGE_TEST_PROFILE_VERSION,
  isMergePilotRequested,
  type MergePilotRoleId,
} from "./merge-policy.js";
import {
  MergePilotAuthorityError,
  lookupActivePilotProfile,
  lookupPilotRun,
  PILOT_GRANT_SYMBOL,
  type MergePilotGrant,
} from "./merge-pilot-registry.js";
import type { FactoryDb } from "../persistence/db.js";

export { MergePilotAuthorityError, PILOT_GRANT_SYMBOL } from "./merge-pilot-registry.js";
export type { MergePilotGrant } from "./merge-pilot-registry.js";

/** Effective env narrowing (lowering only) of the profile budget ceiling. */
export function mergePilotEnvBudgetLimitMicros(env: Record<string, string | undefined>): number | null {
  const raw = env["FACTORY_MERGE_PILOT_LIMIT_USD"];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new MergePilotAuthorityError(
      "pilot_profile_too_generous",
      `FACTORY_MERGE_PILOT_LIMIT_USD must be a positive number (got "${raw.slice(0, 20)}").`,
    );
  }
  return Math.round(parsed * 1_000_000);
}

/**
 * Resolve the pilot execution grant or refuse. Order of checks is
 * evidence-friendly: env intent -> project id -> profile -> role -> run ->
 * budget. Throws MergePilotAuthorityError (typed code) at the FIRST failure;
 * no budget reservation and no network call happen after a refusal.
 */
export async function resolvePilotGrant(input: {
  db: FactoryDb;
  projectId: string;
  runId: string;
  role: string;
  env?: Record<string, string | undefined>;
}): Promise<MergePilotGrant> {
  const env = input.env ?? process.env;

  // 1. Env REQUESTS the pilot (intent only — authority comes from the DB).
  if (!isMergePilotRequested(env)) {
    throw new MergePilotAuthorityError(
      "pilot_not_requested",
      "Merge pilot not requested via FACTORY_LLM_PROVIDER; standard champions apply.",
    );
  }

  // 2. Exact project id shape (never a project KEY; ids are opaque strings).
  const projectId = input.projectId;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new MergePilotAuthorityError("pilot_project_not_found", "Pilot grant requires an exact projectId.");
  }

  // 3. ACTIVE registered profile for THIS exact project id + pinned version.
  const profile = await lookupActivePilotProfile(input.db, projectId);
  if (!profile) {
    throw new MergePilotAuthorityError(
      "pilot_profile_not_registered",
      `No ACTIVE Merge pilot profile is registered for project "${projectId.slice(0, 12)}…"; realtime pilot authority is registry-only.`,
    );
  }

  // 4. Profile sanity — pinned constants, publication authority, no broadening.
  if (profile.provider !== MERGE_PILOT_PROVIDER || profile.model !== MERGE_PILOT_MODEL) {
    throw new MergePilotAuthorityError(
      "pilot_profile_digest_mismatch",
      `Registered pilot profile drifted from the pinned constants (provider=${profile.provider}, model=${profile.model}).`,
    );
  }
  if (profile.publicationAuthority !== false) {
    throw new MergePilotAuthorityError("pilot_profile_digest_mismatch", "Pilot profile must pin publicationAuthority=false.");
  }
  if (profile.profileVersion !== MERGE_TEST_PROFILE_VERSION) {
    throw new MergePilotAuthorityError(
      "pilot_profile_digest_mismatch",
      `Profile version ${profile.profileVersion} is not the pinned ${MERGE_TEST_PROFILE_VERSION}.`,
    );
  }
  if (deterministicDigest({
      profileVersion: profile.profileVersion,
      projectId: profile.projectId,
      provider: profile.provider,
      model: profile.model,
      allowedRoles: [...(profile.allowedRoles ?? [])].sort(),
      budgetLimitMicros: profile.budgetLimitMicros,
      publicationAuthority: false,
    }) !== profile.profileDigest) {
    throw new MergePilotAuthorityError(
      "pilot_profile_digest_mismatch",
      "Pilot profile authoritative fields no longer match the recorded digest; treat the registration as tampered and fail closed.",
    );
  }

  // 5. Role must be permitted by BOTH the pinned role set and the profile.
  const role = input.role;
  if (!(MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes(role)) {
    throw new MergePilotAuthorityError("pilot_role_not_permitted", `Role ${role} is not part of the pinned pilot roles.`);
  }
  const profileRoles = (profile.allowedRoles ?? []) as readonly string[];
  if (!profileRoles.includes(role)) {
    throw new MergePilotAuthorityError(
      "pilot_role_not_permitted",
      `Role ${role} is not in the registered profile's allowed roles (${profileRoles.join(", ")}).`,
    );
  }

  // 6. Exact run binding: the run belongs to THIS profile AND THIS project
  // and is ACTIVE. A proposal whose run is revoked stops being live-authoritative
  // immediately; already-saved proposals stay pilot-labelled via provenance.
  const run = await lookupPilotRun(input.db, input.runId);
  if (!run) {
    throw new MergePilotAuthorityError("pilot_run_not_found", `Pilot run "${input.runId.slice(0, 16)}…" not found.`);
  }
  if (run.profileId !== profile.id) {
    throw new MergePilotAuthorityError("pilot_run_project_mismatch", "Pilot run belongs to a different profile — project binding mismatch.");
  }
  if (run.projectId !== projectId) {
    throw new MergePilotAuthorityError("pilot_run_project_mismatch", "Pilot run belongs to a different project.");
  }
  if (run.state !== "ACTIVE") {
    throw new MergePilotAuthorityError("pilot_run_not_active", `Pilot run is ${run.state}; live authority requires an ACTIVE run.`);
  }

  // 7. Budget ceiling: env may lower the profile ceiling, never raise it.
  const envLimit = mergePilotEnvBudgetLimitMicros(env);
  if (envLimit != null && envLimit > profile.budgetLimitMicros) {
    throw new MergePilotAuthorityError(
      "pilot_profile_too_generous",
      `Env budget (${envLimit}µ) exceeds the registered profile ceiling (${profile.budgetLimitMicros}µ).`,
    );
  }
  if (profile.budgetLimitMicros > MERGE_PILOT_BUDGET_LIMIT_MICROS) {
    throw new MergePilotAuthorityError(
      "pilot_profile_too_generous",
      `Registered profile ceiling exceeds the hard $2 pilot ceiling (${profile.budgetLimitMicros}µ).`,
    );
  }
  const effective = envLimit != null ? Math.min(envLimit, profile.budgetLimitMicros) : profile.budgetLimitMicros;

  // Grant object: module-private symbol key prevents literal-object forgery.
  const grant = Object.freeze({
    [PILOT_GRANT_SYMBOL]: true as const,
    profileId: profile.id,
    profileVersion: profile.profileVersion,
    profileDigest: profile.profileDigest,
    projectId,
    runId: input.runId,
    provider: MERGE_PILOT_PROVIDER,
    model: MERGE_PILOT_MODEL,
    role: role as MergePilotRoleId,
    budgetLimitMicros: profile.budgetLimitMicros,
    publicationAuthority: false as const,
    effectiveBudgetLimitMicros: effective,
  });
  return grant as MergePilotGrant;
}

/** Type-guard used by the adapter on the trusted execution boundary. */
export function isMergePilotGrant(value: unknown): value is MergePilotGrant {
  return (
    typeof value === "object" &&
    value !== null &&
    PILOT_GRANT_SYMBOL in value &&
    (value as MergePilotGrant)[PILOT_GRANT_SYMBOL] === true
  );
}

/**
 * Publication-authority prohibition derived from the grant: P1-03 requires
 * "Writer Proposal saved ≠ Content Accepted ≠ Production Approved"; helper
 * reused by downstream gates for the message.
 */
export function mergePilotPublicationForbiddenError(): FactoryError {
  return new FactoryError(
    "merge_pilot_publication_forbidden",
    "Merge pilot artifacts have NO publication authority: acceptance/approval/publication is forbidden for TEST-ONLY pilot scope.",
  );
}
