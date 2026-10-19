# Factory — Macro Run 13: Discovery and Integration Gap Analysis

**Baseline:** main `bc39a165ce6002cd8e51268bbfea42bcf76d282b`  
**Run 12:** PR #46 merged; exact main post-merge [CI #39341252481](https://github.com/sutherlandamcom/factory/actions/runs/39341252481) **SUCCESS**.  
**Independent Run 12 approval:** No GitHub review or issue comment found on PR #46 during discovery; do **not** infer independent approval merely from merge. External acceptance evidence was not provided.  
**Run 13 implementation branch:** `feat/run13-production-delivery-vnext`; never push directly to main or self-merge.

## Verified components and mandatory reuse

- `production/store.ts`, `production/build-service.ts`: immutable multi-page `ProductionCandidate`, exact page/input/manifest/redirect/artifact digest bindings, current QA report and persisted trust provenance.
- `delivery/driver.ts`, `service.ts`, `wrangler.ts`: Cloudflare versions upload, preview, promotion, deployment drift detection, remote QA, rollback, PostgreSQL status, recovery.
- `operator/api.ts`, `server.ts`: local operator API, but currently no production-release actions; local-host/origin restriction is not genuine reviewer identity.
- `dashboard/pages/DeploymentPage.tsx`: read-only readiness. Candidate, QA and blockers already visible.
- `trust/editorial-review-boundary.ts`: signed external IdP verification, persistent session revocation and project membership reusable for release **only if** release permission/audience and audited authority are explicitly defined.

## Critical gaps

| ID | Gap | Acceptance |
| --- | --- | --- |
| G1 | Legacy CLI builds `sites/starter` from origin/main rather than uploading the immutable ProductionCandidate | Release uploads exact candidate distribution without regeneration |
| G2 | `delivery/digestArtifact` and `production/computeArtifactDigest` use different SHA-256 canonicalization | Never compare as equivalent; verify candidate canonical digest on staged bytes |
| G3 | Candidate `artifactRef` is local; Wrangler reads `sites/starter/dist` | Verify available bytes, reject symlinks and untrusted paths, stage to isolated Wrangler worktree and rehash |
| G4 | No release-specific human approval | Signed genuine reviewer, active project release permission, durable candidate/QA/artifact/preview-version binding, revocation checks |
| G5 | Legacy `execute()` automatically promotes after preview | Separate preview → explicit human approval → publish; reuse the existing common delivery engine |
| G6 | Staleness/races between preview and publish | Under project/delivery lock, verify current upstream acceptance, current strict-production QA, approval, provider target/version and idempotency |
| G7 | Logical site identity vs DB site/Cloudflare Worker mapping | Server checks project, site, worker and canonical host are consistent |
| G8 | Recovery covers mainly promoting/promoted | Recover human-paused preview stages without implicit promotion and reconcile interrupted mutations |
| G9 | Dashboard and API incomplete | Candidate/preview/approve/publish/verify/history/rollback actions, state-controlled and backend-enforced |
| G10 | Remote QA must cover six-page candidate | Check route set, SEO metadata, current Cloudflare version, rollback result |
| G11 | Existing CLI can bypass candidate-bound publishing | Block or route governed sites through the same release authority; preserve scoped legacy compatibility |

## Minimal architecture

```text
Candidate + accepted input/content/design/assets + current trusted QA
       ↓ server-side readiness, target identity, immutable byte verification
Persisted preview preparation → Wrangler upload → real Preview QA
       ↓
Durable PREVIEW_VERIFIED release identity (candidate/QA/version/artifact)
       ↓
Authenticated external-IdP operator APPROVES exact preview
       ↓
Backend rechecks signed actor, project release permission, staleness,
QA evidence, candidate bytes, Cloudflare target/version and conflict lock
       ↓
Existing Wrangler promote(EXACT previewed version)
       ↓
Real production QA + provider active-version check
       ├── PASS → VERIFIED + durable deployment history
       └── FAIL → known-good rollback + real production QA
                           ├── PASS → ROLLED_BACK
                           └── FAIL → NEEDS_REVIEW
```

Use `deployments` as the existing state machine. Extend with narrowly scoped candidate/QA/approval lineage and an append-only release approval record only where necessary. UI is never an authority. Do not add a second deployment engine, CMS, RBAC system, queue or generic workflow engine.

## Phases / checkpoints

1. Verify merge, exact-SHA CI and independent evidence; isolate branch.
2. Implement candidate byte staging and digest equivalence tests (G1–G3); do not publish automatically.
3. Build persistently separated preview using existing Cloudflare operations and QA, with conflict/recovery testing.
4. Add real reviewer identity and release approval with project-scoped permissions and revocation.
5. Add governed publish / verify / rollback application services, maintaining legacy behavior only for explicitly ungoverned sites.
6. Expose thin Operator API actions and Dashboard; cover positive/negative real-browser journeys.
7. Run PostgreSQL 18 migrations on populated database, unit/integration, concurrency, security, real-browser E2E and Run 11/12 regression.
8. Freeze exact SHA, obtain independent QA GO, then authorized merge. Live Cloudflare requires separate human authorization and actual target verification.

## Must-pass acceptance scenarios

| Test | Scenario / expected behavior |
| --- | --- |
| T01 | Genuine approval + current candidate + preview QA PASS → publish exact preview-verified version; production QA PASS → VERIFIED |
| T02 | Pending/built/QA-failed/stale candidate → block |
| T03 | Synthetic or missing identity; forged JSON actor → block |
| T04 | Modified bytes, symlink/path injection, missing candidate → block before upload |
| T05 | Mismatched project/site/worker/QA evidence → block |
| T06 | Preview QA failure → no promotion |
| T07 | Preview version ID differs from approved version → block |
| T08 | Content/design/assets/claims/review revoked after preview → approval stale, block |
| T09 | Expired/revoked IdP assertion or revoked project permission → block |
| T10 | Concurrent publish and repeated request → at most one promotion |
| T11 | Crash immediately after provider mutation → reconcile safely |
| T12 | Provider drift/split traffic/absent known-good → fail closed |
| T13 | Production QA failure after B and known-good A → restore A with real QA |
| T14 | Rollback QA fails → NEEDS_REVIEW, never success |
| T15 | Full Dashboard → API → PostgreSQL real-browser positive journey |
| T16 | Direct API bypass must fail identically to UI |
| T17 | Migration with pre-existing deployment records preserves history |
| T18 | All candidate routes including six Sutherland pages, sitemap and canonical metadata checked |
| T19 | Legacy CLI cannot publish governed candidate without release approval |
| T20 | Run 11 and Run 12 baseline tests unchanged and green |

## Evidence and status discipline

- **Technical complete** requires executed deterministic QA, PostgreSQL E2E, real browser, production QA and exact-SHA CI. Merely adding methods/tests cannot earn it.
- **Independently accepted** requires a different agent's GO at that exact SHA. Builder cannot self-approve.
- **Live deployment verified** requires a real, explicitly authorized Cloudflare operation plus production/DNS checks; provider mocks do not count.
- No production Publish / live rollback without verified credentials, actual authority and informed operator approval.

This record documents verified gaps and plan. Run 13 is NOT declared technically complete by creating this file.
