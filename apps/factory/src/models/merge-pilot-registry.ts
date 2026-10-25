/**
 * MERGE PILOT REGISTRY — durable TEST-ONLY authority persistence (P0-01).
 *
 * The pilot profile is REGISTRY-backed authority: an operator registers an
 * exact project binding through a trusted application service (never a
 * browser-selectable route), and the runtime guard resolves grants only from
 * these tables. Env variables may *narrow* (lower budget) but never *broaden*
 * (no project, revoked profile/run, wrong model) authority.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  mergePilotProfiles,
  mergePilotRuns,
  type MergePilotProfileRecord,
  type MergePilotRunRecord,
} from "../persistence/schema.js";
import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import {
  MERGE_PILOT_MODEL,
  MERGE_PILOT_PROVIDER,
  MERGE_PILOT_ALLOWED_ROLES,
  MERGE_TEST_PROFILE_VERSION,
  type MergePilotRoleId,
} from "./merge-policy.js";
import { deterministicDigest } from "../intelligence/digest.js";

/** Typed error surface for pilot authority resolution (fail closed). */
export type MergePilotAuthorityErrorCode =
  | "pilot_not_requested"
  | "pilot_project_not_found"
  | "pilot_profile_not_registered"
  | "pilot_profile_revoked"
  | "pilot_profile_digest_mismatch"
  | "pilot_role_not_permitted"
  | "pilot_run_not_found"
  | "pilot_run_not_active"
  | "pilot_run_project_mismatch"
  | "pilot_profile_too_generous";

export class MergePilotAuthorityError extends FactoryError {
  constructor(
    readonly code: MergePilotAuthorityErrorCode,
    message: string,
  ) {
    super(code, message);
  }
}

/** Opaque, non-serializable grant carrying the module-private marker symbol. */
export const PILOT_GRANT_SYMBOL: unique symbol = Symbol("factory.mergePilotGrant");

export interface MergePilotGrant {
  readonly [PILOT_GRANT_SYMBOL]: true;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileDigest: string;
  readonly projectId: string;
  readonly runId: string;
  readonly provider: typeof MERGE_PILOT_PROVIDER;
  readonly model: typeof MERGE_PILOT_MODEL;
  readonly role: MergePilotRoleId;
  readonly budgetLimitMicros: number;
  readonly publicationAuthority: false;
  /** Requested env narrowing (<= profile ceiling); authoritative for budget. */
  readonly effectiveBudgetLimitMicros: number;
}

export interface MergePilotRunInit {
  runId: string;
  projectId: string;
  note?: string;
}

export interface RegisterMergePilotProfileInput {
  projectId: string;
  /** Operator identity recorded on the durable row (reviewable evidence). */
  approvedBy: string;
  /** Optional narrowing of the whole-pilot ceiling (never > $2). */
  budgetLimitMicros?: number;
  /** Optional role narrowing (never broader than the pinned role set). */
  allowedRoles?: readonly MergePilotRoleId[];
  profileVersion?: string;
}

/** Digest over the authoritative fields of a profile registration. */
export function computeProfileDigest(input: {
  profileVersion: string;
  projectId: string;
  provider: string;
  model: string;
  allowedRoles: readonly string[];
  budgetLimitMicros: number;
  publicationAuthority: false;
}): string {
  return deterministicDigest({
    profileVersion: input.profileVersion,
    projectId: input.projectId,
    provider: input.provider,
    model: input.model,
    allowedRoles: [...input.allowedRoles].sort(),
    budgetLimitMicros: input.budgetLimitMicros,
    publicationAuthority: input.publicationAuthority,
  });
}

/**
 * Register (or re-assert) an ACTIVE pilot profile for an EXACT project id.
 * Trusted-service only: callers are the operator CLI/script; there is no
 * HTTP/dashboard path to this function.
 */
export async function registerMergePilotProfile(
  db: FactoryDb,
  input: RegisterMergePilotProfileInput,
): Promise<{ profile: MergePilotProfileRecord }> {
  if (!Number.isSafeInteger(input.budgetLimitMicros ?? 2_000_000)) {
    throw new FactoryError("budget_invariant_violation", "Pilot budget limit must be a safe integer in micros.");
  }
  const allowedRoles = [...(input.allowedRoles ?? MERGE_PILOT_ALLOWED_ROLES)].sort();
  for (const role of allowedRoles) {
    if (!(MERGE_PILOT_ALLOWED_ROLES as readonly string[]).includes(role)) {
      throw new FactoryError("merge_pilot_policy_violation", `Role ${role} is not part of the pinned pilot role set.`);
    }
  }
  const profileVersion = input.profileVersion ?? MERGE_TEST_PROFILE_VERSION;

  return await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`SELECT id FROM projects WHERE id = ${input.projectId}`,
    );
    if (rows.length === 0) {
      throw new MergePilotAuthorityError("pilot_project_not_found", `Pilot registration requires an existing project id (${input.projectId.slice(0, 12)}…).`);
    }
    const profileId = `mpp-${randomUUID()}`;
    const budgetLimitMicros = input.budgetLimitMicros ?? 2_000_000;
    const profileDigest = computeProfileDigest({
      profileVersion,
      projectId: input.projectId,
      provider: MERGE_PILOT_PROVIDER,
      model: MERGE_PILOT_MODEL,
      allowedRoles,
      budgetLimitMicros,
      publicationAuthority: false,
    });
    // Upsert-by-(project, version) is deliberately NOT allowed to broaden:
    // re-registration must match the previous authoritative fields exactly,
    // otherwise the operator must first revoke explicitly.
    const existing = await tx
      .select()
      .from(mergePilotProfiles)
      .where(
        and(
          eq(mergePilotProfiles.projectId, input.projectId),
          eq(mergePilotProfiles.profileVersion, profileVersion),
        ),
      );
    const active = existing.filter((row) => row.state !== "REVOKED" && row.state !== "BLOCKED");
    if (active.length > 0) {
      const prior = active[0]!;
      if (prior.profileDigest !== profileDigest) {
        throw new MergePilotAuthorityError(
          "pilot_profile_too_generous",
          "An ACTIVE pilot profile exists for this project+version with different authoritative fields; revoke it explicitly before re-registering.",
        );
      }
      return { profile: prior };
    }
    const [created] = await tx
      .insert(mergePilotProfiles)
      .values({
        id: profileId,
        profileVersion,
        projectId: input.projectId,
        provider: MERGE_PILOT_PROVIDER,
        model: MERGE_PILOT_MODEL,
        allowedRoles,
        budgetLimitMicros,
        state: "ACTIVE",
        publicationAuthority: false,
        approvedBy: input.approvedBy,
        profileDigest,
      })
      .returning();
    return { profile: created! };
  });
}

export async function revokeMergePilotProfile(
  db: FactoryDb,
  input: { projectId: string; profileVersion?: string },
): Promise<void> {
  const profileVersion = input.profileVersion ?? MERGE_TEST_PROFILE_VERSION;
  await db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(mergePilotProfiles)
      .where(
        and(
          eq(mergePilotProfiles.projectId, input.projectId),
          eq(mergePilotProfiles.profileVersion, profileVersion),
        ),
      );
    if (!profile) {
      throw new MergePilotAuthorityError("pilot_profile_not_registered", "No pilot profile to revoke for this project.");
    }
    await tx
      .update(mergePilotProfiles)
      .set({ state: "REVOKED", revokedAt: new Date() })
      .where(eq(mergePilotProfiles.id, profile.id));
    await tx
      .update(mergePilotRuns)
      .set({ state: "REVOKED", closedAt: new Date() })
      .where(and(eq(mergePilotRuns.profileId, profile.id), eq(mergePilotRuns.state, "ACTIVE")));
  });
}

/** Open a bounded run window for an ACTIVE profile (exact project binding). */
export async function openMergePilotRun(
  db: FactoryDb,
  input: { projectId: string; profileVersion?: string; note?: string },
): Promise<{ run: MergePilotRunRecord }> {
  const profileVersion = input.profileVersion ?? MERGE_TEST_PROFILE_VERSION;
  return await db.transaction(async (tx) => {
    const [profile] = await tx
      .select()
      .from(mergePilotProfiles)
      .where(
        and(
          eq(mergePilotProfiles.projectId, input.projectId),
          eq(mergePilotProfiles.profileVersion, profileVersion),
        ),
      );
    if (!profile || profile.state !== "ACTIVE") {
      throw new MergePilotAuthorityError(
        profile?.state === "BLOCKED" ? "pilot_profile_revoked" : "pilot_profile_not_registered",
        `No ACTIVE pilot profile for project ${input.projectId.slice(0, 12)}… (fail closed).`,
      );
    }
    const runId = `mpr-${randomUUID()}`;
    const [created] = await tx
      .insert(mergePilotRuns)
      .values({ id: runId, profileId: profile.id, projectId: input.projectId, state: "ACTIVE", note: input.note ?? null })
      .returning();
    return { run: created! };
  });
}

export async function closeMergePilotRun(db: FactoryDb, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(mergePilotRuns)
      .set({ state: "CLOSED", closedAt: new Date() })
      .where(and(eq(mergePilotRuns.id, runId), eq(mergePilotRuns.state, "ACTIVE")));
  });
}

/** Direct registry lookup used by the guard (cheap indexed reads). */
export async function lookupActivePilotProfile(
  db: FactoryDb,
  projectId: string,
): Promise<MergePilotProfileRecord | null> {
  const [profile] = await db
    .select()
    .from(mergePilotProfiles)
    .where(
      and(
        eq(mergePilotProfiles.projectId, projectId),
        eq(mergePilotProfiles.profileVersion, MERGE_TEST_PROFILE_VERSION),
      ),
    );
  return profile ?? null;
}

export async function lookupPilotRun(
  db: FactoryDb,
  runId: string,
): Promise<MergePilotRunRecord | null> {
  const [run] = await db.select().from(mergePilotRuns).where(eq(mergePilotRuns.id, runId));
  return run ?? null;
}
