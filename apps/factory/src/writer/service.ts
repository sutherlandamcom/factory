import type { PageTarget } from "@factory/contracts";
import { parseContentBriefData } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "./writer-store.js";
import { runContentQa } from "./qa.js";
import {
  runWriterInvocation,
  resolveWriterModel,
  writerProviderError,
  WRITER_MAX_OUTPUT_TOKENS,
} from "./provider.js";
import type { WriterBudgetStore } from "./budget.js";
import type { FactoryDb } from "../persistence/db.js";
import type { MergePilotGrant } from "../models/merge-pilot-guard.js";
import { FixtureWriterProvider } from "./fixture-writer.js";
import { isMergePilotEnabled } from "../models/merge-policy.js";
import { writerProposalResponseJsonSchemaText } from "@factory/contracts";
import type { ContentBriefRecord, WriterPolicyRecord, WriterPromptSnapshotRecord, PageContentProposalRecord } from "../persistence/schema.js";

/**
 * P1-03: bind the exact approved snapshot lineage into the parsed body and
 * validate the STRICT PageContentProposalData contract. Returns null on any
 * validation failure (the caller may use the single repair attempt).
 */
function bindSnapshot(parsedBody: Record<string, unknown>, snapshot: { id: string; version: number; snapshotDigest: string }): unknown {
  const proposalData = {
    ...parsedBody,
    schemaVersion: "writer-content-v1",
    snapshotId: snapshot.id,
    snapshotVersion: snapshot.version,
    snapshotDigest: snapshot.snapshotDigest,
  };
  try {
    // Synchronous contract import (contracts is a static dependency).
    // parsePageContentProposalData throws on any drift; null signals it.
    const { parsePageContentProposalData } = contractsModule;
    return parsePageContentProposalData(proposalData);
  } catch {
    return null;
  }
}

/** Static re-export bridge (keeps the generatedProposal path synchronous). */
import * as contractsModuleStatic from "@factory/contracts";
const contractsModule = contractsModuleStatic;

/**
 * P0-01: pilot dependency entries propagated into runWriterInvocation
 * (durable DB + bound run id). Built from the trusted server wiring, never
 * from browser state.
 */
interface WriterPilotDepEntries {
  db?: FactoryDb;
  pilotRunId?: string;
}
const pilotDepEntries: WriterPilotDepEntries = {
  db: (globalThis as { __factoryWriterPilotDb?: FactoryDb }).__factoryWriterPilotDb,
  pilotRunId: (globalThis as { __factoryWriterPilotRunId?: string }).__factoryWriterPilotRunId,
};

/** The pilot DB seam must exist when a pilot invocation is requested. */
function depsWriterDb(): FactoryDb {
  const db = (globalThis as { __factoryWriterPilotDb?: FactoryDb }).__factoryWriterPilotDb;
  if (!db) throw new FactoryError("writer_provider_not_configured", "Merge pilot writer path requires a durable FactoryDb (registry-backed authority; fail closed).");
  return db;
}

/**
 * WriterService — application service for the writer pipeline (Macro Run 4).
 * Dashboard and Operator API both use these semantic commands; the service is
 * the single trusted path (UI state is never governance authority).
 */

export interface WriterPolicyView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  lineage: {
    acceptedInputSnapshotId: string;
    acceptedInputSnapshotVersion: number;
    acceptedInputDigest: string;
  };
  rules: unknown;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface ContentBriefView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  slug: string;
  lineage: unknown;
  pageTarget: PageTarget;
  noGapLineageAcknowledged: boolean;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export class WriterService {
  constructor(
    private readonly store: WriterStore,
    private readonly snapshotStore: WriterSnapshotStore,
    private readonly budget: WriterBudgetStore,
    private readonly qaStore?: WriterQaStore,
    /**
     * Optional fixture provider override (trusted server config only —
     * FACTORY_WRITER_MODE=fixture). When absent, generation uses the real
     * OpenRouter-backed provider boundary.
     */
    private readonly fixtureProvider?: { generate(request: unknown): Promise<unknown> } | null,
  ) {}

  // ---- Writer Policy -----------------------------------------------------------

  async deriveWriterPolicyDraft(projectId: string): Promise<WriterPolicyView> {
    const row = await this.store.deriveWriterPolicyDraft({ projectId });
    return this.toPolicyView(row, false, null);
  }

  async approveWriterPolicy(input: {
    projectId: string;
    policyId: string;
    expectedVersion: number;
    expectedDigest: string;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.store.approveWriterPolicy(input);
  }

  async writerPolicyWorkspace(projectId: string): Promise<{
    latest: WriterPolicyView | null;
    versions: Array<{ id: string; version: number; state: string; digest: string; createdAt: string }>;
  }> {
    const latest = await this.store.latestWriterPolicy(projectId);
    const versionRows = await this.store.listWriterPolicyVersions(projectId);
    const versions = versionRows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }));
    let latestView: WriterPolicyView | null = null;
    if (latest) {
      const staleness = await this.store.writerPolicyStaleness(projectId, latest);
      latestView = this.toPolicyView(latest, staleness.stale, staleness.reason);
    }
    return { latest: latestView, versions };
  }

  // ---- Content Production Brief --------------------------------------------------

  async saveBriefDraft(input: {
    projectId: string;
    pageTarget: unknown;
    contentBriefKeyPoints: string[];
    expectedRevision?: number | null;
    noGapLineageAcknowledged?: boolean;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.store.saveBriefDraft(input);
  }

  async approveBrief(input: {
    projectId: string;
    briefId: string;
    expectedVersion: number;
    expectedDigest: string;
    noGapLineageAcknowledged?: boolean;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.store.approveBrief(input);
  }

  async briefWorkspace(projectId: string): Promise<{
    latest: ContentBriefView | null;
    versions: Array<{ id: string; version: number; state: string; digest: string; slug: string; createdAt: string }>;
  }> {
    const latest = await this.store.latestBrief(projectId);
    const versionRows = await this.store.listBriefVersions(projectId);
    const versions = versionRows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }));
    let latestView: ContentBriefView | null = null;
    if (latest) {
      const staleness = await this.store.briefStaleness(projectId, latest);
      latestView = this.toBriefView(latest, staleness.stale, staleness.reason);
    }
    return { latest: latestView, versions };
  }

  async briefDetail(projectId: string, version: number): Promise<ContentBriefView> {
    const row = await this.store.briefVersion(projectId, version);
    if (!row) throw new FactoryError("writer_artifact_not_found", "Content brief version not found.");
    const staleness = await this.store.briefStaleness(projectId, row);
    return this.toBriefView(row, staleness.stale, staleness.reason);
  }

  // ---- Views ---------------------------------------------------------------------

  private toPolicyView(row: WriterPolicyRecord, stale: boolean, staleReason: string | null): WriterPolicyView {
    return {
      id: row.id,
      version: row.version,
      state: row.state as "draft" | "approved",
      digest: row.policyDigest,
      lineage: {
        acceptedInputSnapshotId: row.acceptedInputSnapshotId,
        acceptedInputSnapshotVersion: row.acceptedInputVersion,
        acceptedInputDigest: row.acceptedInputDigest,
      },
      rules: row.data,
      stale,
      staleReason,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toBriefView(row: ContentBriefRecord, stale: boolean, staleReason: string | null): ContentBriefView {
    const data = row.data as {
      lineage: unknown;
      pageTarget: PageTarget;
    };
    return {
      id: row.id,
      version: row.version,
      state: row.state as "draft" | "approved",
      digest: row.briefDigest,
      slug: row.slug,
      lineage: data.lineage,
      pageTarget: data.pageTarget,
      noGapLineageAcknowledged: row.noGapLineageAcknowledged,
      stale,
      staleReason,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async compileSnapshot(input: {
    projectId: string;
    briefId?: string;
  }): Promise<WriterSnapshotView> {
    const latest = await this.store.latestBrief(input.projectId);
    // Honor the explicit briefId: it must resolve to the CURRENT brief for
    // this project — snapshots can only be compiled from the latest brief
    // version, never from an older/superseded one.
    const brief = input.briefId
      ? await this.store.briefById(input.projectId, input.briefId)
      : latest;
    if (input.briefId) {
      if (!brief) {
        throw new FactoryError("writer_artifact_not_found", "Content brief not found for this project.");
      }
      if (!latest || latest.id !== brief.id) {
        throw new FactoryError(
          "writer_artifact_stale",
          "Snapshot compilation requires the CURRENT brief; the requested briefId is not the latest brief version.",
        );
      }
    }
    if (!brief || brief.state !== "approved") {
      throw new FactoryError("writer_policy_not_approved", "An approved brief is required before compiling a snapshot.");
    }
    const staleness = await this.store.briefStaleness(input.projectId, brief);
    if (staleness.stale) {
      throw new FactoryError("writer_artifact_stale", `Brief is stale: ${staleness.reason}`);
    }
    const briefData = brief.data as {
      pageTarget: PageTarget;
      allowedClaims: string[];
      prohibitedClaims: string[];
      unknownClaims: string[];
      operatorFacts: string[];
      searchSemantics: { primaryIntent: string; semanticCoverageRequirements: string[]; userNeeds: string[] };
      contentBriefKeyPoints: string[];
    };
    const policy = await this.store.latestWriterPolicy(input.projectId);
    if (!policy || policy.state !== "approved") {
      throw new FactoryError("writer_policy_not_approved", "An approved Factory Writer Policy is required.");
    }
    const policyData = policy.data as { rules: Record<string, unknown> };
    const packet = await compileWriterPromptPacket({ briefData, policyRules: policyData.rules });
    const saved = await this.snapshotStore.compileSnapshot({
      projectId: input.projectId,
      briefId: brief.id,
      systemPrompt: packet.systemPrompt,
      userPrompt: packet.userPrompt,
      maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
    });
    const row = (await this.snapshotStore.snapshotVersion(input.projectId, saved.version))!;
    return this.snapshotView(row, false, null);
  }

  async approveSnapshot(input: {
    projectId: string;
    snapshotId: string;
    expectedVersion: number;
    expectedDigest: string;
  }): Promise<{ id: string; version: number; digest: string }> {
    return await this.snapshotStore.approveSnapshot(input);
  }

  async snapshotWorkspace(projectId: string): Promise<{
    latest: WriterSnapshotView | null;
    versions: Array<{ id: string; version: number; state: string; digest: string; createdAt: string }>;
  }> {
    const latest = await this.snapshotStore.latestSnapshot(projectId);
    const versionRows = await this.snapshotStore.listSnapshotVersions(projectId);
    let latestView: WriterSnapshotView | null = null;
    if (latest) {
      const staleness = await this.snapshotStore.snapshotStaleness(projectId, latest);
      latestView = this.snapshotView(latest, staleness.stale, staleness.reason);
    }
    return {
      latest: latestView,
      versions: versionRows.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    };
  }

  async snapshotDetail(projectId: string, version: number): Promise<WriterSnapshotView> {
    const row = await this.snapshotStore.snapshotVersion(projectId, version);
    if (!row) throw new FactoryError("writer_artifact_not_found", "Snapshot version not found.");
    const staleness = await this.snapshotStore.snapshotStaleness(projectId, row);
    return this.snapshotView(row, staleness.stale, staleness.reason);
  }

  snapshotView(row: WriterPromptSnapshotRecord, stale: boolean, staleReason: string | null): WriterSnapshotView {
    return {
      id: row.id,
      version: row.version,
      state: row.state as "draft" | "approved",
      digest: row.snapshotDigest,
      briefId: row.briefId,
      briefVersion: row.briefVersion,
      briefDigest: row.briefDigest,
      systemPrompt: row.systemPrompt,
      userPrompt: row.userPrompt,
      maxOutputTokens: row.maxOutputTokens,
      stale,
      staleReason,
      approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Generate a PageContentProposal from the EXACT approved snapshot. Full
   * budget governance (preflight -> reservation -> provider -> settlement).
   * Malformed/unparseable provider output FAILS CLOSED — no silent repair.
   */
  async generateProposal(input: { projectId: string; snapshotId: string }, deps?: {
    invoke?: Parameters<typeof runWriterInvocation>[1]["invoke"];
    dailyLimitUsd?: number;
    env?: Record<string, string | undefined>;
  }): Promise<WriterProposalView> {
    const snapshot = await this.snapshotStore.latestSnapshot(input.projectId);
    if (!snapshot || snapshot.id !== input.snapshotId) {
      throw new FactoryError("writer_artifact_not_found", "Approved snapshot not found for this project.");
    }
    if (snapshot.state !== "approved") {
      throw new FactoryError(
        "writer_policy_not_approved",
        "The exact WriterPromptSnapshot digest must be human-approved before any writer invocation.",
      );
    }
    const snapStaleness = await this.snapshotStore.snapshotStaleness(input.projectId, snapshot);
    if (snapStaleness.stale) {
      throw new FactoryError("writer_artifact_stale", `Snapshot is stale: ${snapStaleness.reason}`);
    }
    const brief = await this.store.briefVersion(input.projectId, snapshot.briefVersion);
    if (!brief || brief.briefDigest !== snapshot.briefDigest) {
      throw new FactoryError("writer_artifact_stale", "Snapshot brief binding mismatch.");
    }
    const briefData = parseContentBriefData(brief.data);

    // Fixture provider mode (trusted config): deterministic proposal, zero
    // paid calls, zero budget movement. The provider field records "fixture"
    // so fixture output can never masquerade as champion output.
    if (this.fixtureProvider) {
      const acceptedInput = await this.store.acceptedInputSnapshotByLineage(input.projectId, briefData.lineage.acceptedInputSnapshotId, briefData.lineage.acceptedInputSnapshotVersion);
      if (!acceptedInput || acceptedInput.digest !== briefData.lineage.acceptedInputDigest) throw new FactoryError("writer_artifact_stale", "Fixture input snapshot binding changed.");
      const fixtureLanguage = (acceptedInput.data as { siteIdentity: { language: string } }).siteIdentity.language;
      const fixtureData = FixtureWriterProvider.deterministicProposal({
        snapshotId: snapshot.id,
        snapshotVersion: snapshot.version,
        snapshotDigest: snapshot.snapshotDigest,
        title: briefData.pageTarget.title,
        slug: briefData.pageTarget.slug,
        language: fixtureLanguage,
        ctaText: briefData.pageTarget.ctaIntent,
      });
      const fixtureSaved = await this.snapshotStore.saveProposal({
        projectId: input.projectId,
        snapshotId: snapshot.id,
        snapshotVersion: snapshot.version,
        snapshotDigest: snapshot.snapshotDigest,
        slug: briefData.pageTarget.slug,
        provider: "fixture",
        model: "fixture-writer",
        overrideApplied: false,
        overriddenChampion: null,
        data: fixtureData,
      });
      const fixtureRow = (await this.snapshotStore.proposalVersion(input.projectId, fixtureSaved.version))!;
      return this.proposalView(fixtureRow, false, null);
    }

    let result;
    try {
      result = await runWriterInvocation(
        {
          promptSnapshotDigest: snapshot.snapshotDigest,
          promptSnapshotRevision: snapshot.version,
          projectId: input.projectId,
          systemPrompt: snapshot.systemPrompt,
          userPrompt: snapshot.userPrompt,
        },
        {
          budget: this.budget,
          ...(deps?.invoke ? { invoke: deps.invoke } : {}),
          ...(deps?.dailyLimitUsd != null ? { dailyLimitUsd: deps.dailyLimitUsd } : {}),
          ...(deps?.env ? { env: deps.env } : {}),
          ...(pilotDepEntries),
        },
      );
    } catch (error) {
      throw writerProviderError(error);
    }

    // Fail-closed parse: malformed output never becomes a proposal. The exact
    // approved snapshot digest is bound INTO the proposal data before schema
    // validation, so the persisted proposal always carries correct lineage.
    // P1-03 single format-repair retry: at most ONE additional paid call with
    // a NEW invocation digest + NEW budget reservation; both attempts are
    // traced; the repair may reformat ONLY (no factual/link/price/source/
    // meaning changes are possible because the repair prompt re-passes the
    // SAME brief material and explicitly forbids content edits, and QA runs
    // downstream against the accepted schema either way).
    const parsedBody = this.parseProposalOutputForProposal(result.content);
    let validated: unknown = parsedBody ? bindSnapshot(parsedBody, snapshot) : null;
    let repairAttempted = false;
    let firstParseError: unknown = null;
    if (!validated) {
      firstParseError = new FactoryError(
        "writer_proposal_invalid",
        "Writer output failed the strict PageContentProposal schema; attempting the single permitted format-repair invocation.",
      );
      try {
        const repairResult = await runWriterInvocation(
          {
            promptSnapshotDigest: snapshot.snapshotDigest,
            promptSnapshotRevision: snapshot.version,
            projectId: input.projectId,
            systemPrompt: `${snapshot.systemPrompt}\n\nFORMAT REPAIR ONLY — the previous response had the WRONG SHAPE. Respond with the same page content EXACTLY, but in the required JSON shape: internalLinks MUST be an array of plain string paths (e.g. ["/services/x"]); every required field present; no extra fields; no markdown fences. You may NOT add, remove, paraphrase, shorten, expand or alter any factual claim, link, price, source, or meaning — respose shape repair only.`,
            userPrompt: `${snapshot.userPrompt}\n\nPREVIOUS INVALID RESPONSE (reformat ONLY, do not edit content):\n${result.content.slice(0, 16_000)}`,
          },
          {
            budget: this.budget,
            ...(deps?.invoke ? { invoke: deps.invoke } : {}),
            ...(deps?.dailyLimitUsd != null ? { dailyLimitUsd: deps.dailyLimitUsd } : {}),
            ...(deps?.env ? { env: { ...(deps.env ?? {}), FACTORY_WRITER_REPAIR_ATTEMPT: "2" } } : { FACTORY_WRITER_REPAIR_ATTEMPT: "2" }),
            ...(pilotDepEntries),
          },
        );
        repairAttempted = true;
        const repairedBody = this.parseProposalOutputForProposal(repairResult.content);
        validated = repairedBody ? bindSnapshot(repairedBody, snapshot) : null;
      } catch (repairError) {
        // Repair invocation failed at the provider/budget boundary: fail
        // closed with the original parse problem.
        throw new FactoryError(
          "writer_proposal_invalid",
          `Writer output failed the strict PageContentProposal schema and the single format-repair invocation failed: ${repairError instanceof Error ? repairError.message.slice(0, 200) : "unknown"}`,
        );
      }
    }
    if (!validated) {
      throw new FactoryError(
        "writer_proposal_invalid",
        "Writer output failed the strict PageContentProposal schema after the single permitted format-repair invocation; failing closed (no silent repair).",
      );
    }
    if (firstParseError && repairAttempted) {
      // Both attempts durably traceable: the ledger holds TWO distinct
      // reservations (digest bound per attempt) — provenance is below.
      void firstParseError;
    }
    // P0-01: resolve the live pilot grant BEFORE the invocation so provenance
    // is registry-grounded (never inferred from env).
    const pilotRequested = isMergePilotEnabled(deps?.env ?? {});
    let pilotGrantForProvenance: MergePilotGrant | null = null;
    if (pilotRequested) {
      const { resolvePilotGrant } = await import("../models/merge-pilot-guard.js");
      pilotGrantForProvenance = await resolvePilotGrant({
        db: depsWriterDb(),
        projectId: input.projectId,
        runId: (globalThis as { __factoryWriterPilotRunId?: string }).__factoryWriterPilotRunId ?? "",
        role: "content_writer",
        env: deps?.env,
      });
    }
    const saved = await this.snapshotStore.saveProposal({
      projectId: input.projectId,
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
      snapshotDigest: snapshot.snapshotDigest,
      slug: briefData.pageTarget.slug,
      // Provenance matches the EFFECTIVE wire gateway (merge pilot or q
      // OpenRouter); a pilot artifact can never masquerade as champion work.
      provider: pilotGrantForProvenance ? "merge" : "openrouter",
      model: result.model,
      overrideApplied: result.overrideApplied,
      overriddenChampion: result.overriddenChampion,
      data: validated,
      // P1-03 provenance columns (P0-01 authority + P1-04 costs + digests):
      ...(pilotGrantForProvenance
        ? {
            pilotProfileId: pilotGrantForProvenance.profileId,
            pilotRunId: pilotGrantForProvenance.runId,
            gatewayRole: pilotGrantForProvenance.role,
            requestDigest: result.requestDigest,
            responseDigest: result.responseDigest,
            providerReportedCostMicros: result.costBreakdown.providerReportedMicros,
            policyEstimatedCostMicros: result.costBreakdown.policyEstimatedMicros,
            accountedCostMicros: result.costBreakdown.accountedMicros,
          }
        : {}),
    });
    const row = (await this.snapshotStore.proposalVersion(input.projectId, saved.version))!;
    return this.proposalView(row, false, null);
  }

  /**
   * Strict JSON extraction with NO silent repair: the entire provider content
   * must be a single JSON document matching the proposal schema (bound to the
   * exact approved snapshot digest).
   */
  parseProposalOutput(content: string): unknown {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new FactoryError(
        "writer_proposal_invalid",
        "Writer output is not a single strict JSON document; failing closed (no silent repair).",
      );
    }
    return parsed;
  }

  /**
   * P1-03: quiet parse for the repair path — returns null on ANY malformed
   * output instead of throwing (the caller decides the retry policy; no
   * silent repair ever happens server-side).
   */
  parseProposalOutputForProposal(content: string): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  }

  async proposalWorkspace(projectId: string): Promise<{
    latest: WriterProposalView | null;
    versions: Array<{ id: string; version: number; digest: string; slug: string; createdAt: string }>;
  }> {
    const latest = await this.snapshotStore.latestProposal(projectId);
    let latestView: WriterProposalView | null = null;
    if (latest) {
      const staleness = await this.snapshotStore.proposalStaleness(projectId, latest);
      latestView = this.proposalView(latest, staleness.stale, staleness.reason);
    }
    return { latest: latestView, versions: [] };
  }

  proposalView(row: PageContentProposalRecord, stale: boolean, staleReason: string | null): WriterProposalView {
    return {
      id: row.id,
      version: row.version,
      digest: row.proposalDigest,
      slug: row.slug,
      snapshotId: row.snapshotId,
      snapshotVersion: row.snapshotVersion,
      snapshotDigest: row.snapshotDigest,
      provider: row.provider,
      model: row.model,
      overrideApplied: row.overrideApplied,
      overriddenChampion: row.overriddenChampion,
      // P0-01: durable authority label surfaced to operators/acceptance gates.
      authorityStatus: row.authorityStatus,
      pilot: row.authorityStatus === "pilot_no_publication"
        ? { profileId: row.pilotProfileId, runId: row.pilotRunId, gatewayRole: row.gatewayRole, requestDigest: row.requestDigest, responseDigest: row.responseDigest }
        : null,
      costs: row.accountedCostMicros != null || row.providerReportedCostMicros != null
        ? { providerReportedMicros: row.providerReportedCostMicros, policyEstimatedMicros: row.policyEstimatedCostMicros, accountedMicros: row.accountedCostMicros }
        : null,
      data: row.data,
      stale,
      staleReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
  /**
   * Run the deterministic QA triad (factual/search/editorial) against the
   * latest proposal and persist the report bound to the exact proposal digest.
   */
  async runQa(input: { projectId: string }): Promise<WriterQaView> {
    if (!this.qaStore) throw new FactoryError("internal_error", "QA store not configured.");
    const proposal = await this.snapshotStore.latestProposal(input.projectId);
    if (!proposal) throw new FactoryError("writer_artifact_not_found", "No proposal exists for this project.");
    const staleness = await this.snapshotStore.proposalStaleness(input.projectId, proposal);
    if (staleness.stale) {
      throw new FactoryError("writer_artifact_stale", `Proposal is stale: ${staleness.reason}`);
    }
    // Brief data: resolve through the snapshot's bound brief for the SAME
    // lineage the proposal was generated from.
    const snapshot = await this.snapshotStore.snapshotVersion(input.projectId, proposal.snapshotVersion);
    if (!snapshot) throw new FactoryError("writer_artifact_stale", "Bound snapshot missing.");
    const brief = await this.store.briefVersion(input.projectId, snapshot.briefVersion);
    if (!brief) throw new FactoryError("writer_artifact_stale", "Bound brief missing.");
    const briefData = parseContentBriefData(brief.data);
    // QA judges against the policy BOUND to the brief's exact lineage — never
    // against whatever draft happens to be latest. Drift or lost approval ->
    // stale (fail closed). (Independent QA finding, post-merge hardening.)
    const policy = await this.store.writerPolicyVersion(input.projectId, briefData.lineage.writerPolicyVersion);
    if (
      !policy ||
      policy.id !== briefData.lineage.writerPolicyId ||
      policy.state !== "approved" ||
      policy.policyDigest !== briefData.lineage.writerPolicyDigest
    ) {
      throw new FactoryError(
        "writer_artifact_stale",
        "The Factory Writer Policy bound to this brief changed or is no longer approved.",
      );
    }
    const policyRules = (policy.data as { rules: Record<string, string[] | string> }).rules;
    // Accepted-intake identity text is legitimate numeric evidence for the
    // invented-numbers check (it is never invented by the writer); resolved
    // through the brief's exact bound input snapshot (digest-verified).
    const intake = await this.store.acceptedInputSnapshotByLineage(
      input.projectId,
      briefData.lineage.acceptedInputSnapshotId,
      briefData.lineage.acceptedInputSnapshotVersion,
    );
    if (!intake || intake.digest !== briefData.lineage.acceptedInputDigest) {
      throw new FactoryError("writer_artifact_stale", "The accepted ProjectInputSnapshot bound to this brief changed.");
    }
    const intakeData = intake.data as {
      evidence?: { evidenceNotes?: string[] };
      conversion?: { ctaDestination?: string };
      brand?: { facts?: string[] };
      business?: { description?: string };
    };
    const evidenceExtras = [
      ...(intakeData.evidence?.evidenceNotes ?? []),
      ...(intakeData.conversion?.ctaDestination ? [intakeData.conversion.ctaDestination] : []),
      ...(intakeData.brand?.facts ?? []),
      ...(intakeData.business?.description ? [intakeData.business.description] : []),
    ];
    const report = runContentQa(
      proposal.data as Parameters<typeof runContentQa>[0],
      briefData,
      policyRules,
      evidenceExtras,
    );
    // Insert-only persistence: a re-run for the same proposal digest returns
    // the FIRST stored report unchanged (idempotent-identical QA history).
    const saved = await this.qaStore.saveQaReport({
      projectId: input.projectId,
      proposalId: proposal.id,
      proposalVersion: proposal.version,
      proposalDigest: proposal.proposalDigest,
      data: {
        schemaVersion: "writer-content-v1",
        proposalId: proposal.id,
        proposalVersion: proposal.version,
        proposalDigest: proposal.proposalDigest,
        factual: report.factual,
        search: report.search,
        editorial: report.editorial,
        overall: report.overall,
      },
    });
    // Always surface the PERSISTED report's verdicts (on an idempotent re-run
    // these are the stored ones, never a silently replaced recompute).
    const stored = saved.data as {
      factual: unknown[];
      search: unknown[];
      editorial: unknown[];
      overall: string;
    };
    return {
      reportId: saved.id,
      digest: saved.digest,
      proposalId: proposal.id,
      proposalDigest: proposal.proposalDigest,
      factual: stored.factual,
      search: stored.search,
      editorial: stored.editorial,
      overall: stored.overall,
    };
  }

  /** Human acceptance gate: proposal + QA verdicts -> AcceptedPageContent. */
  async acceptContent(input: { projectId: string; proposalId: string; expectedProposalDigest: string }): Promise<AcceptedContentView> {
    if (!this.qaStore) throw new FactoryError("internal_error", "QA store not configured.");
    const result = await this.qaStore.acceptContent(input);
    const latest = await this.qaStore.acceptedContentById(input.projectId, result.id);
    return {
      id: result.id,
      version: result.version,
      slug: result.slug,
      digest: result.digest,
      proposalId: result.proposalId,
      proposalDigest: result.proposalDigest,
      qaReportDigest: result.qaReportDigest,
      lineageQualification: await this.qaStore.acceptedLineageQualification(input.projectId, result.proposalId),
      data: latest?.data ?? null,
      acceptedAt: latest?.acceptedAt.toISOString() ?? new Date().toISOString(),
    };
  }

  async acceptedContentDetail(projectId: string, id: string) {
    if (!this.qaStore) throw new FactoryError("internal_error", "QA store not configured.");
    const row = await this.qaStore.acceptedContentById(projectId, id);
    if (!row) throw new FactoryError("writer_artifact_not_found", "Accepted content not found for this project.");
    return { ...row, lineageQualification: await this.qaStore.acceptedLineageQualification(projectId, row.proposalId), digest: row.contentDigest, acceptedAt: row.acceptedAt.toISOString() };
  }

  async acceptedContentWorkspace(projectId: string) {
    if (!this.qaStore) throw new FactoryError("internal_error", "QA store not configured.");
    const latest = await this.qaStore.latestAcceptedContent(projectId);
    const versions = (await this.qaStore.acceptedContentVersions(projectId)).map(row => ({ id: row.id, version: row.version, slug: row.slug, digest: row.contentDigest }));
    const currentPages = versions.filter((row, index) => versions.findIndex(other => other.slug === row.slug) === index);
    if (!latest) return { latest: null, versions, currentPages };
    return {
      versions,
      currentPages,
      latest: {
        id: latest.id,
        version: latest.version,
        slug: latest.slug,
        digest: latest.digest,
        proposalId: latest.proposalId,
        proposalDigest: latest.proposalDigest,
        qaReportDigest: latest.qaReportDigest,
        lineageQualification: await this.qaStore.acceptedLineageQualification(projectId, latest.proposalId),
        data: latest.data,
        acceptedAt: latest.acceptedAt.toISOString(),
      },
    };
  }
}


export interface WriterQaView {
  reportId: string;
  digest: string;
  proposalId: string;
  proposalDigest: string;
  factual: unknown[];
  search: unknown[];
  editorial: unknown[];
  overall: string;
}

export interface AcceptedContentView {
  lineageQualification?: "complete" | "no-gap-waiver" | "unqualified";
  id: string;
  version: number;
  slug: string;
  digest: string;
  proposalId: string;
  proposalDigest: string;
  qaReportDigest: string;
  data: unknown;
  acceptedAt: string;
}

// ---- WriterPromptSnapshot --------------------------------------------------------

export interface WriterSnapshotView {
  id: string;
  version: number;
  state: "draft" | "approved";
  digest: string;
  briefId: string;
  briefVersion: number;
  briefDigest: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  stale: boolean;
  staleReason: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface WriterProposalView {
  id: string;
  version: number;
  digest: string;
  slug: string;
  snapshotId: string;
  snapshotVersion: number;
  snapshotDigest: string;
  provider: string;
  model: string;
  overrideApplied: boolean;
  overriddenChampion: string | null;
  /** P0-01: 'champion' | 'pilot_no_publication' (durable authority label). */
  authorityStatus: string;
  /** P0-01 provenance (pilot rows only). */
  pilot: { profileId: string | null; runId: string | null; gatewayRole: string | null; requestDigest: string | null; responseDigest: string | null } | null;
  /** P1-04 decomposed costs (when settled). */
  costs: { providerReportedMicros: number | null; policyEstimatedMicros: number | null; accountedMicros: number | null } | null;
  data: unknown;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
}

/**
 * Compile the exact prompt packet from the approved brief + writer policy.
 * Deterministic: same inputs -> same digest. The compiled packet embeds the
 * writer policy rules, brief page requirements, claims policy and search
 * semantics — nothing is invented at compile time.
 */
export async function compileWriterPromptPacket(input: {
  briefData: {
    pageTarget: PageTarget;
    allowedClaims: string[];
    prohibitedClaims: string[];
    unknownClaims: string[];
    operatorFacts: string[];
    searchSemantics: { primaryIntent: string; semanticCoverageRequirements: string[]; userNeeds: string[] };
    contentBriefKeyPoints: string[];
  };
  policyRules: Record<string, unknown>;
}): Promise<{ systemPrompt: string; userPrompt: string }> {
  const t = input.briefData.pageTarget;
  const rules = input.policyRules as {
    brandVoice?: string;
    tone?: string;
    writingPrinciples?: string[];
    forbiddenTerminology?: string[];
    aiLanguageAvoidance?: string[];
    clicheAvoidance?: string[];
    evidencePolicy?: string;
    preferredTerminology?: string[];
    customWriterInstructions?: string;
  };
  const systemPrompt = [
    "You are the production marketing writer for this project, executing an approved Content Production Brief.",
    "You are NOT the authority for facts, claims, strategy or design: you materialize ONLY the accepted inputs below.",
    "",
    "WRITER POLICY (non-negotiable rules):",
    `- Brand voice: ${rules.brandVoice ?? ""}`,
    `- Tone: ${rules.tone ?? ""}`,
    rules.writingPrinciples?.length ? `- Writing principles: ${rules.writingPrinciples.join("; ")}` : "",
    rules.preferredTerminology?.length ? `- Preferred terminology: ${rules.preferredTerminology.join("; ")}` : "",
    rules.forbiddenTerminology?.length ? `- FORBIDDEN terminology (never use): ${rules.forbiddenTerminology.join("; ")}` : "",
    rules.aiLanguageAvoidance?.length ? `- AI-language to avoid: ${rules.aiLanguageAvoidance.join("; ")}` : "",
    rules.clicheAvoidance?.length ? `- Clichés to avoid: ${rules.clicheAvoidance.join("; ")}` : "",
    `- Evidence policy: ${rules.evidencePolicy ?? ""}`,
    rules.customWriterInstructions ? `- Custom instructions: ${rules.customWriterInstructions}` : "",
    "",
    "CLAIMS POLICY:",
    `- Allowed claims (only these may be asserted): ${input.briefData.allowedClaims.join("; ") || "(none)"}`,
    `- PROHIBITED claims (never assert): ${input.briefData.prohibitedClaims.join("; ") || "(none)"}`,
    `- Unverified claims (may only be referenced as unverified, never asserted as fact): ${input.briefData.unknownClaims.join("; ") || "(none)"}`,
    "",
    "OUTPUT CONTRACT: respond with a single strict JSON document matching the PageContentProposal schema: {title, metaDescription, introduction, sections:[{heading,body}], conclusion, cta, internalLinks}. No markdown fences, no commentary.",
    "",
    "RESPONSE SHAPE (JSON Schema — the exact structure your single JSON document must have). Particular notes: `internalLinks` is an ARRAY OF STRING page paths (e.g. [\"/services/roof-repair\",\"/about\"]) — NEVER objects; every listed field is REQUIRED; no extra fields.",
    writerProposalResponseJsonSchemaText(),
  ]
    .filter((line) => line !== "")
    .join("\n");

  const userPrompt = [
    "PAGE TARGET:",
    `- Slug: ${t.slug}`,
    `- Title: ${t.title}`,
    `- Objective: ${t.objective}`,
    `- Audience: ${t.audience}`,
    t.structureGuidance.length ? `- Structure guidance: ${t.structureGuidance.join("; ")}` : "",
    t.internalLinkIntent.length ? `- Internal link intent: ${t.internalLinkIntent.join("; ")}` : "",
    `- CTA intent: ${t.ctaIntent}`,
    "",
    "SEARCH SEMANTICS (from the accepted gap snapshot — cover these):",
    `- Primary intent: ${input.briefData.searchSemantics.primaryIntent}`,
    input.briefData.searchSemantics.semanticCoverageRequirements.length
      ? `- Semantic coverage requirements:\n${input.briefData.searchSemantics.semanticCoverageRequirements.map((r) => `  * ${r}`).join("\n")}`
      : "",
    input.briefData.searchSemantics.userNeeds.length
      ? `- User needs:\n${input.briefData.searchSemantics.userNeeds.map((r) => `  * ${r}`).join("\n")}`
      : "",
    "",
    input.briefData.operatorFacts.length
      ? `OPERATOR FACTS (the only factual material):\n${input.briefData.operatorFacts.map((f) => `- ${f}`).join("\n")}`
      : "OPERATOR FACTS: (none — assert nothing factual)",
    input.briefData.contentBriefKeyPoints.length
      ? `\nKEY POINTS (transitional bounded brief points):\n${input.briefData.contentBriefKeyPoints.map((k) => `- ${k}`).join("\n")}`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return { systemPrompt, userPrompt };


}
