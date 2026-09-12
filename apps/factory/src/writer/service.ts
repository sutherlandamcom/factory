import type { PageTarget } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { WriterStore, WriterSnapshotStore } from "./writer-store.js";
import {
  runWriterInvocation,
  resolveWriterModel,
  writerProviderError,
  WRITER_MAX_OUTPUT_TOKENS,
} from "./provider.js";
import type { WriterBudgetStore } from "./budget.js";
import type { ContentBriefRecord, WriterPolicyRecord, WriterPromptSnapshotRecord, PageContentProposalRecord } from "../persistence/schema.js";

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
    const brief = input.briefId
      ? await this.store.briefVersion(input.projectId, (await this.store.latestBrief(input.projectId))!.version)
      : await this.store.latestBrief(input.projectId);
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
    const briefData = brief.data as { pageTarget: PageTarget };

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
        },
      );
    } catch (error) {
      throw writerProviderError(error);
    }

    // Fail-closed parse: malformed output never becomes a proposal. The exact
    // approved snapshot digest is bound INTO the proposal data before schema
    // validation, so the persisted proposal always carries correct lineage.
    const parsedBody = this.parseProposalOutput(result.content) as Record<string, unknown>;
    const proposalData = {
      ...parsedBody,
      schemaVersion: "writer-content-v1",
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
      snapshotDigest: snapshot.snapshotDigest,
    };
    const { parsePageContentProposalData } = await import("@factory/contracts");
    let validated: unknown;
    try {
      validated = parsePageContentProposalData(proposalData);
    } catch {
      throw new FactoryError(
        "writer_proposal_invalid",
        "Writer output failed the strict PageContentProposal schema; failing closed (no silent repair).",
      );
    }
    const saved = await this.snapshotStore.saveProposal({
      projectId: input.projectId,
      snapshotId: snapshot.id,
      snapshotVersion: snapshot.version,
      snapshotDigest: snapshot.snapshotDigest,
      slug: briefData.pageTarget.slug,
      provider: "openrouter",
      model: result.model,
      overrideApplied: result.overrideApplied,
      overriddenChampion: result.overriddenChampion,
      data: validated,
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
      data: row.data,
      stale,
      staleReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
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

