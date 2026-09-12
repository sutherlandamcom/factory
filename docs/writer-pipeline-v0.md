# Writer Pipeline v0 — implemented state (Macro Run 4)

Status: implementation candidate on branch `feat/content-writer-v0`, awaiting
independent QA. This document describes the accepted implementation, not a
future plan. Historical "future" statements elsewhere do not override the
roadmap sequencing.

## Authority model

The coding worker is NOT writer authority. Final page copy is produced by the
`content_writer` policy role through a governed pipeline in which every
artifact is versioned, digest-bound and human-approved before the next stage
runs. Models propose; Factory validates and governs.

## Pipeline stages (all persisted, versioned, digest-bound)

1. **Factory Writer Policy** — derived deterministically from the LATEST
   accepted `ProjectInputSnapshot`'s Content Constitution (the intake snapshot
   stays the single source of truth; the policy is a governed projection, not
   a second editable SOT). Approve exact revision + digest → immutable
   approved version; edits → new draft version; old versions inspectable;
   stale approval rejected with `writer_artifact_stale`.
2. **Content Production Brief** — page-level, composed deterministically from:
   accepted input lineage (id/version/digest), approved writer policy
   (id/version/digest), operator Page Target fields (slug, title, objective,
   audience, structure guidance, internal-link/CTA intent — brief draft
   fields, NOT a pages registry), allowed/prohibited/unknown claims and
   operator facts from accepted intake, and the accepted ContentGap snapshot
   lineage INCLUDING its `searchSemantics` (the Runs 2–3 search-evidence
   bridge).
3. **Gap lineage rule** — default: an accepted ContentGap snapshot is REQUIRED
   (`content_gap_lineage_missing` otherwise). The operator may explicitly draft
   AND approve a brief without gap lineage only by setting
   `noGapLineageAcknowledged: true` at draft time (a brief without an accepted
   gap snapshot cannot be created otherwise) and again at approval time; the
   flag is persisted on the brief row, digest-bound (it is part of the brief
   payload), carried through approval, and shown in the Dashboard. Passing the
   flag while an accepted gap snapshot exists fails closed. No silent fallback
   either way.
4. **WriterPromptSnapshot** — the EXACT compiled prompt packet (deterministic
   canonical-JSON SHA-256 digest, server-side). Persisted, Dashboard-visible,
   human-reviewable. Staleness: bound brief changed OR a newer approved brief
   exists. NO paid writer call before explicit human approval of the exact
   snapshot digest (optimistic concurrency: expected revision + digest).
5. **PageContentProposal** — structured writer output bound to the exact
   approved snapshot digest. Malformed/unparseable output FAILS CLOSED (no
   silent repair). Usage/cost telemetry persisted; budget settled per the
   reservation ledger rules.
6. **Deterministic QA triad** — factual / search / editorial checks, each
   emitting PASS/REVIEW/FAIL with evidence references. NO numeric scores, NO
   keyword-density/LSI scoring. All three families are fully deterministic in
   v0 (documented decision: every acceptance criterion is deterministically
   expressible against the accepted inputs; no model-based editorial check is
   required). QA reports are INSERT-ONLY: a re-run for the same proposal
   digest is idempotent-identical (the first stored report is returned, never
   replaced), so an accepted row's `qa_report_digest` reference can never be
   orphaned by a later re-run.
7. **AcceptedPageContent** — human acceptance gate. Fails closed without a QA
   report for the exact proposal digest, on QA overall FAIL, on digest
   mismatch, on stale snapshot binding, OR on any transitive upstream
   mutation behind the bound brief (accepted ProjectInputSnapshot, approved
   Writer Policy, accepted ContentGap snapshot) with `writer_artifact_stale`.
   Concurrent acceptances that race the version allocation fail closed with
   the typed `content_accept_failed` conflict. Immutable; same-slug
   re-acceptance with a different proposal requires a new brief version.
   REVIEW overall permits the human gate to decide.

## Budget governance

- Migration `0010` adds `writer_budget_reservations` reusing the EXACT
  lifecycle mechanism of the competitor ledger (migration 0009): ceiling-check
  + INSERT in one transaction under the shared budget advisory xact lock,
  ACTIVE → ACCOUNTED | RELEASED, trusted-usage retention across failures,
  requestSubmitted-keyed release, unknown cost → authorized conservative
  amount, overrun → full accounting + `budget_invariant_violation`.
- Daily limit: `FACTORY_WRITER_DAILY_LIMIT_USD`.
- Credential preflight: missing/unusable credential → typed
  `writer_provider_not_configured`, zero provider calls. Model id comes from
  policy/config, never browser input.

## Dev-time model override seam (Phase 0)

- `resolveRoleModel(roleId, env)` in `apps/factory/src/models/policy.ts` is
  the single resolution point. Env key: `FACTORY_MODEL_OVERRIDE__<ROLE_ID>`
  (e.g. `FACTORY_MODEL_OVERRIDE__CONTENT_WRITER`).
- Default behavior with no override is byte-identical champion resolution.
- `model_invocations` records the ACTUAL model plus `override_applied` /
  `overridden_champion`; reservation lineage records the same. An artifact
  produced under an override never masquerades as champion-produced.
- DEV-TIME ONLY: operator server startup hard-fails when any override is set
  in CI/acceptance mode or a gated live-proof path
  (`apps/factory/src/models/override-guard.ts`); live-proof paths additionally
  require production provider mode (no fixture). Prominent startup
  diagnostics and a Dashboard "DEV MODEL OVERRIDE ACTIVE" banner surface every
  active override.
- Trusted pricing (`model-pricing-v0.3`): `anthropic/claude-opus-5` at the
  verified OpenRouter catalog rates ($5/$25 per 1M tokens);
  `z-ai/glm-5.3-flash` at conservative ceilings above the verified catalog
  ($0.10/$0.30 per 1M). Unknown/unpriced models fail closed everywhere.

## Provider boundary

`WriterProvider` is a thin, replaceable boundary; the OpenRouter adapter is
the production path for the Opus champion. Bounded request: exact approved
snapshot packet, bounded max output tokens (16,000), provider-side price
ceiling from trusted pricing. `FACTORY_WRITER_MODE=fixture` selects the
deterministic fixture provider (trusted backend config only; zero paid calls;
proposals record provider "fixture" so fixture output cannot masquerade as
champion output).

## Live-vs-CI policy

CI and acceptance environments run fixture provider modes and forbid model
overrides (hard startup failure). Live writer acceptance requires an explicit
operator authorization and is executed as a single bounded call with the real
champion, recorded in `model_invocations` — never assumed from a green CI run.

## Transitional exception

The pre-vNext `contentBrief.keyPoints` compatibility behavior is NOT retired
in this run. It is marked deprecated in code and here: **retires after
AcceptedPageContent pipeline acceptance**.
