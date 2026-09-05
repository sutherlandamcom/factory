import type { ProjectIntakePayload } from "@factory/contracts";

/**
 * Deterministic Project Intake readiness (no AI, no I/O).
 *
 * Blockers prevent acceptance; warnings do not. Missing FUTURE research
 * outputs (SERP snapshots, query clusters, content gaps, designs, assets)
 * never block intake — those belong to later pipeline stages.
 */
export interface IntakeDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface IntakeReadiness {
  readonly status: "DRAFT" | "READY" | "APPROVED" | "CHANGED" | "BLOCKED";
  readonly blockers: readonly IntakeDiagnostic[];
  readonly warnings: readonly IntakeDiagnostic[];
  readonly nextActions: readonly string[];
}

function isBlank(v: string | undefined | null): boolean {
  return v === undefined || v === null || v.trim().length === 0;
}

function nonEmpty(list: readonly string[] | undefined): boolean {
  return Array.isArray(list) && list.some((v) => v.trim().length > 0);
}

/** Evaluate intake readiness deterministically from the payload alone. */
export function evaluateIntakeReadiness(payload: ProjectIntakePayload): IntakeReadiness {
  const blockers: IntakeDiagnostic[] = [];
  const warnings: IntakeDiagnostic[] = [];
  const nextActions: string[] = [];

  if (isBlank(payload.business.name)) {
    blockers.push({
      code: "INTAKE_BUSINESS_NAME_REQUIRED",
      message: "Business name is required before inputs can be accepted.",
    });
    nextActions.push("Enter the business name.");
  }
  if (isBlank(payload.business.description)) {
    blockers.push({
      code: "INTAKE_BUSINESS_DESCRIPTION_REQUIRED",
      message: "A short business description is required.",
    });
    nextActions.push("Describe the business in a sentence or two.");
  }
  if (isBlank(payload.siteIdentity.language)) {
    blockers.push({
      code: "INTAKE_SITE_LANGUAGE_REQUIRED",
      message: "Site language is required.",
    });
    nextActions.push("Set the site language (e.g. en).");
  }

  const origin = payload.siteIdentity.candidateDomain?.trim() ?? "";
  if (origin.length > 0) {
    const valid =
      /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?\/?$/i.test(origin) ||
      /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(origin);
    if (!valid) {
      blockers.push({
        code: "INTAKE_INVALID_CANONICAL_ORIGIN",
        message: `Candidate domain "${origin}" is not a valid domain or origin.`,
      });
      nextActions.push("Correct the candidate domain/origin.");
    }
  }

  if (payload.conversion.verificationState === "UNVERIFIED" || payload.conversion.verificationState === "UNKNOWN") {
    warnings.push({
      code: "INTAKE_CTA_DESTINATION_UNVERIFIED",
      message: "Conversion destination is not yet verified.",
    });
  }
  if (!nonEmpty(payload.searchSeeds.queries) && !nonEmpty(payload.searchSeeds.topics)) {
    warnings.push({
      code: "INTAKE_NO_SEARCH_SEEDS",
      message: "No search seeds supplied yet; Search Intelligence will start from scratch.",
    });
  }
  if (!nonEmpty(payload.searchSeeds.competitors)) {
    warnings.push({
      code: "INTAKE_NO_COMPETITORS",
      message: "No known competitors supplied.",
    });
  }
  if (!payload.assetAvailability.hasAuthenticPhotography && !payload.assetAvailability.hasLocalFirstPartyPhotography) {
    warnings.push({
      code: "INTAKE_NO_PHOTOGRAPHY",
      message: "No authentic photography recorded as available.",
    });
  }

  const status: IntakeReadiness["status"] = blockers.length > 0 ? "BLOCKED" : "READY";
  return { status, blockers, warnings, nextActions };
}
