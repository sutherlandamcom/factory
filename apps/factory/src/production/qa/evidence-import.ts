import { readFile } from "node:fs/promises";
import { createDatabaseInstance, type FactoryDb } from "../../persistence/db.js";
import { resolveDatabaseConfig } from "../../persistence/config.js";
import { ProductionStore } from "../store.js";
import { FactoryError } from "../../executor/errors.js";
import { productionQaCheckResultSchema } from "@factory/contracts";

/**
 * Trusted production-QA evidence import — shared application service.
 *
 * This is the single authority seam for importing persisted candidate-bound
 * trusted QA evidence (axe, keyboard, Lighthouse, gitleaks, OSV). Both the
 * operator CLI (`factory production qa-import`) and the Run 11 Operator API
 * QA collector use this exact function, so evidence semantics (allowed
 * check kinds, digest binding, candidate identity) live in ONE place.
 *
 * Import is NOT QA approval: a candidate reaches qa_passed only through
 * ProductionApiFacade.runCandidateQa after evidence is persisted.
 */

const TRUSTED_EVIDENCE_CHECK_IDS = new Set([
  "accessibility.axe",
  "accessibility.keyboard",
  "performance.lighthouse",
  "security.gitleaks",
  "security.osv",
]);

export interface TrustedQaEvidenceReport {
  artifactDigest?: string;
  repositorySha?: string;
  lockfileDigest?: string;
  checks?: unknown[];
}

export interface ImportTrustedQaEvidenceInput {
  projectId: string;
  candidateId: string;
  report: TrustedQaEvidenceReport;
}

/**
 * Parse and persist a trusted evidence report for one exact candidate.
 * Throws typed FactoryError on malformed reports, unsupported check kinds,
 * identity mismatches, or unknown candidates (fail closed).
 *
 * `db` — an existing FactoryDb instance (the caller's connection); the
 * standalone CLI path constructs one from the environment.
 */
export async function importTrustedQaEvidence(
  input: ImportTrustedQaEvidenceInput & { db?: FactoryDb },
): Promise<{ imported: number }> {
  const raw = input.report;
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new FactoryError("production_qa_failed", "Trusted evidence report contains no checks.");
  }
  const checks = raw.checks.map((entry) => productionQaCheckResultSchema.parse(entry));
  if (checks.some((check) => !TRUSTED_EVIDENCE_CHECK_IDS.has(check.checkId))) {
    throw new FactoryError(
      "production_qa_failed",
      "Trusted importer accepts only browser, Lighthouse, Gitleaks, and OSV evidence.",
    );
  }
  if (input.db) {
    const store = new ProductionStore(input.db);
    for (const check of checks) {
      await store.recordTrustedQaEvidence({
        projectId: input.projectId,
        candidateId: input.candidateId,
        check,
        artifactDigest: raw.artifactDigest,
        repositorySha: raw.repositorySha,
        lockfileDigest: raw.lockfileDigest,
      });
    }
    return { imported: checks.length };
  }
  const config = resolveDatabaseConfig({ requireConfigured: true });
  const dbInst = createDatabaseInstance(config);
  try {
    const store = new ProductionStore(dbInst.db);
    for (const check of checks) {
      await store.recordTrustedQaEvidence({
        projectId: input.projectId,
        candidateId: input.candidateId,
        check,
        artifactDigest: raw.artifactDigest,
        repositorySha: raw.repositorySha,
        lockfileDigest: raw.lockfileDigest,
      });
    }
    return { imported: checks.length };
  } finally {
    await dbInst.close();
  }
}

/**
 * CLI-facing variant: read + parse an evidence report from a trusted local
 * file path (operator CLI argument, never browser input) and import it.
 */
export async function importTrustedQaEvidenceFromFile(
  input: { projectId: string; candidateId: string; evidencePath: string },
): Promise<{ imported: number }> {
  const raw = JSON.parse(
    await readFile(input.evidencePath, "utf8"),
  ) as TrustedQaEvidenceReport;
  return importTrustedQaEvidence({
    projectId: input.projectId,
    candidateId: input.candidateId,
    report: raw,
  });
}
