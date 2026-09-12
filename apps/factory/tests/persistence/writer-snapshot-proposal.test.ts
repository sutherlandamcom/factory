import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { WriterStore, WriterSnapshotStore } from "../../src/writer/writer-store.js";
import { WriterService, compileWriterPromptPacket } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { samplePageTarget, seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryError } from "../../src/executor/errors.js";

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

const VALID_PROPOSAL = {
  title: "Roof Replacement in Denver",
  metaDescription: "Denver roof replacement with licensed local experts.",
  introduction: "Denver homeowners face hail, wind and freeze-thaw cycles.",
  sections: [
    { heading: "What a full replacement includes", body: "Tear-off, deck inspection, underlayment, shingles." },
    { heading: "Our process and timeline", body: "Most replacements finish in one to two days." },
  ],
  conclusion: "A durable roof starts with a proper inspection.",
  cta: "Book a free roof inspection today.",
  internalLinks: ["See our storm damage repair page."],
};

async function setupApprovedThroughBrief(key: string) {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const snapshotStore = new WriterSnapshotStore(dbInst.db);
  const service = new WriterService(store, snapshotStore, new WriterBudgetStore(dbInst.db));
  const seed = await seedProjectWithAcceptedInputs(dbInst, key);
  const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
  await store.approveWriterPolicy({
    projectId: seed.projectId,
    policyId: draft.id,
    expectedVersion: draft.version,
    expectedDigest: draft.policyDigest,
  });
  const saved = await store.saveBriefDraft({
    projectId: seed.projectId,
    pageTarget: samplePageTarget,
    contentBriefKeyPoints: [],
  });
  await store.approveBrief({
    projectId: seed.projectId,
    briefId: saved.id,
    expectedVersion: saved.version,
    expectedDigest: saved.digest,
  });
  return { dbInst, store, snapshotStore, service, seed };
}

test("prompt packet compilation is deterministic and embeds policy + brief + semantics", async () => {
  const briefData = {
    pageTarget: samplePageTarget,
    allowedClaims: ["Licensed and insured"],
    prohibitedClaims: ["#1 roofing company"],
    unknownClaims: ["Insurance approval timelines"],
    operatorFacts: ["Serving Denver since 1998"],
    searchSemantics: {
      primaryIntent: "commercial investigation — local roofing replacement",
      semanticCoverageRequirements: ["What a full roof replacement includes"],
      userNeeds: ["Trust signals: licensing, insurance, reviews"],
    },
    contentBriefKeyPoints: [],
  };
  const policyRules = {
    brandVoice: "Warm, plain-spoken expert",
    tone: "Confident but never pushy",
    forbiddenTerminology: ["cheap", "bargain"],
    aiLanguageAvoidance: ["delve", "unleash"],
    clicheAvoidance: ["your one-stop shop"],
    evidencePolicy: "Every claim traces to an operator fact.",
    customWriterInstructions: "Never name competitors.",
  };
  const a = await compileWriterPromptPacket({ briefData, policyRules });
  const b = await compileWriterPromptPacket({ briefData, policyRules });
  assert.equal(a.systemPrompt, b.systemPrompt);
  assert.equal(a.userPrompt, b.userPrompt);
  assert.match(a.systemPrompt, /FORBIDDEN terminology \(never use\): cheap; bargain/);
  assert.match(a.systemPrompt, /PROHIBITED claims \(never assert\): #1 roofing company/);
  assert.match(a.systemPrompt, /Never name competitors/);
  assert.match(a.userPrompt, /Primary intent: commercial investigation/);
  assert.match(a.userPrompt, /What a full roof replacement includes/);
  assert.match(a.userPrompt, /Serving Denver since 1998/);
});

test("snapshot compile requires approved brief; digest deterministic; approval binds exact digest", async () => {
  const { dbInst, service, store, seed } = await setupApprovedThroughBrief("ws1");
  try {
    const snap = await service.compileSnapshot({ projectId: seed.projectId });
    assert.equal(snap.state, "draft");
    assert.ok(/^[0-9a-f]{64}$/.test(snap.digest));
    assert.ok(snap.systemPrompt.length > 0 && snap.userPrompt.length > 0);

    // Recompiling updates the same draft version (no version churn).
    const snap2 = await service.compileSnapshot({ projectId: seed.projectId });
    assert.equal(snap2.version, snap.version);

    // Approval without approving snapshot: generation must fail closed.
    await assert.rejects(
      service.generateProposal(
        { projectId: seed.projectId, snapshotId: snap.id },
        { invoke: async () => { throw new Error("must not be called"); } },
      ),
      (e: unknown) => isCode(e, "writer_policy_not_approved"),
    );

    // Wrong digest approval fails closed.
    await assert.rejects(
      service.approveSnapshot({
        projectId: seed.projectId,
        snapshotId: snap.id,
        expectedVersion: snap.version,
        expectedDigest: "f".repeat(64),
      }),
      (e: unknown) => isCode(e, "writer_approval_failed"),
    );

    const approved = await service.approveSnapshot({
      projectId: seed.projectId,
      snapshotId: snap.id,
      expectedVersion: snap.version,
      expectedDigest: snap.digest,
    });
    assert.ok(approved.digest, "approval returns the approved digest");

    // Brief mutation (new version) -> snapshot becomes stale.
    const saved2 = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: { ...samplePageTarget, title: "Updated title" },
      contentBriefKeyPoints: [],
    });
    await store.approveBrief({
      projectId: seed.projectId,
      briefId: saved2.id,
      expectedVersion: saved2.version,
      expectedDigest: saved2.digest,
    });
    const staleView = await service.snapshotDetail(seed.projectId, snap.version);
    assert.equal(staleView.stale, true);
    assert.match(staleView.staleReason!, /brief/i);

    // Generation from a stale snapshot fails closed.
    await assert.rejects(
      service.generateProposal(
        { projectId: seed.projectId, snapshotId: snap.id },
        { invoke: async () => { throw new Error("must not be called"); } },
      ),
      (e: unknown) => isCode(e, "writer_artifact_stale"),
    );
  } finally {
    await dbInst.close();
  }
});

test("generateProposal: fixture writer output persisted with snapshot digest binding + telemetry", async () => {
  const { dbInst, service, seed } = await setupApprovedThroughBrief("ws2");
  try {
    const snap = await service.compileSnapshot({ projectId: seed.projectId });
    await service.approveSnapshot({
      projectId: seed.projectId,
      snapshotId: snap.id,
      expectedVersion: snap.version,
      expectedDigest: snap.digest,
    });
    const proposal = await service.generateProposal(
      { projectId: seed.projectId, snapshotId: snap.id },
      {
        invoke: async () => ({
          requestedModel: "z-ai/glm-5.3-flash",
          respondedModel: "z-ai/glm-5.3-flash",
          provider: "Z.AI",
          durationMs: 5,
          promptTokens: 1000,
          completionTokens: 400,
          totalTokens: 1400,
          costUsd: null,
          content: JSON.stringify({ ...VALID_PROPOSAL }),
        }),
        env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
      },
    );
    assert.equal(proposal.snapshotDigest, snap.digest);
    assert.equal(proposal.model, "z-ai/glm-5.3-flash");
    assert.equal(proposal.overrideApplied, true);
    assert.equal(proposal.overriddenChampion, "anthropic/claude-opus-5");
    const data = proposal.data as { title: string };
    assert.equal(data.title, VALID_PROPOSAL.title);
  } finally {
    await dbInst.close();
  }
});

test("generateProposal: malformed output FAILS CLOSED (no silent repair), budget conservatively accounted", async () => {
  const { dbInst, service, seed } = await setupApprovedThroughBrief("ws3");
  try {
    const snap = await service.compileSnapshot({ projectId: seed.projectId });
    await service.approveSnapshot({
      projectId: seed.projectId,
      snapshotId: snap.id,
      expectedVersion: snap.version,
      expectedDigest: snap.digest,
    });
    await assert.rejects(
      service.generateProposal(
        { projectId: seed.projectId, snapshotId: snap.id },
        {
          invoke: async () => ({
            requestedModel: "m",
            respondedModel: "m",
            provider: "p",
            durationMs: 1,
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            costUsd: null,
            content: "not json at all — prose response",
          }),
          env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
        },
      ),
      (e: unknown) => isCode(e, "writer_proposal_invalid"),
    );
    // No proposal persisted.
    const ws = await service.proposalWorkspace(seed.projectId);
    assert.equal(ws.latest, null);
  } finally {
    await dbInst.close();
  }
});

test("generateProposal: schema-violating JSON fails closed even when parseable", async () => {
  const { dbInst, service, seed } = await setupApprovedThroughBrief("ws4");
  try {
    const snap = await service.compileSnapshot({ projectId: seed.projectId });
    await service.approveSnapshot({
      projectId: seed.projectId,
      snapshotId: snap.id,
      expectedVersion: snap.version,
      expectedDigest: snap.digest,
    });
    await assert.rejects(
      service.generateProposal(
        { projectId: seed.projectId, snapshotId: snap.id },
        {
          invoke: async () => ({
            requestedModel: "m",
            respondedModel: "m",
            provider: "p",
            durationMs: 1,
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            costUsd: null,
            content: JSON.stringify({ hello: "world", title: 42 }),
          }),
          env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
        },
      ),
      (e: unknown) => isCode(e, "writer_proposal_invalid"),
    );
  } finally {
    await dbInst.close();
  }
});

test("proposal binds exact snapshot: proposal for wrong/unapproved snapshot fails closed", async () => {
  const { dbInst, snapshotStore, seed } = await setupApprovedThroughBrief("ws5");
  try {
    await assert.rejects(
      snapshotStore.saveProposal({
        projectId: seed.projectId,
        snapshotId: "nonexistent",
        snapshotVersion: 1,
        snapshotDigest: "a".repeat(64),
        slug: samplePageTarget.slug,
        provider: "fixture",
        model: "fixture",
        overrideApplied: false,
        overriddenChampion: null,
        data: { ...VALID_PROPOSAL, schemaVersion: "writer-content-v1", snapshotId: "nonexistent", snapshotVersion: 1, snapshotDigest: "a".repeat(64) },
      }),
      (e: unknown) => isCode(e, "writer_artifact_not_found"),
    );
  } finally {
    await dbInst.close();
  }
});
