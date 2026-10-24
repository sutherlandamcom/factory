# E2E-01 integrated remediation

Status: **REMEDIATION PARTIAL — VERIFIED FIXES, OPEN BLOCKERS**

Baseline: clean local and remote `main` at
`82741c600aae5af1dd79f867374789b101a5b5cf`, no open PRs at baseline inspection.
Branch: `fix/e2e01-integrated-remediation`. No deployment, paid provider call,
production database access or merge is authorized or performed.

## Changes

- Added explicit repository-owned project/site/profile/accepted-identity/delivery
  binding; workspace reads no longer provision a deployment target. Shared
  backend/store validation binds new production input, candidate and QA identity.
- Preserved historical record readers and recovery against persisted target
  authority. Old evidence is not rewritten into new authority.
- Resolved Search language/geography from exact accepted Intake or explicit
  overrides; recorded provenance and policy version, extended cache identity,
  exposed readiness/defaults and reset stale Dashboard request state.
- Replaced ASCII lexical matching with deterministic Unicode normalization;
  empty intent cannot pass. Lexical alignment is not semantic or factual proof.
- Bound exact accepted CTA copy and verified destination into production
  authority; added accessible anchor semantics and destination/route QA.
  Unsupported forms fail closed until a governed form capability exists.
- Project navigation now comes from the bound profile/manifest and must resolve
  against candidate routes. No second navigation configuration was introduced.
- Fixed claim coverage that could authorize an added quantity through a matching
  substring. Existing source classification, exact content lineage and human
  review remain required; no claim or Intake array redesign was introduced.
- Added isolated Sutherland/Stark output fixtures and a Russian operator journey.
  Fixture provider evidence retains its classification throughout.

## Persistence and compatibility

Migration `0042_search_context.sql` adds nullable `search_runs.request_context`.
It has no destructive backfill. Historical Search rows read as unknown context.
Production contracts retain historical manifest readers; new bound manifests
require conversion, navigation and exact accepted-content authority. Renderer
policy identity is `production-policy-v4`; Search context policy is
`search-context-v1`. The trusted configuration format is
`project-site-binding-v1`. See [configuration instructions](../production-project-site-binding.md).

## Attribution and project data

Intake remains a local single-operator workflow (`acceptedBy: operator`). The
authenticated release/review actor boundary does not provide an authenticated
Intake identity, so no fictitious personal attribution or authentication platform
was added. Stark/RusSilica personnel percentages and industrial-responsibility
claims remain unverified project data and are not production-approved evidence.

## Evidence and remaining gates

The [issue matrix](E2E01_ISSUE_REGISTER_RESOLVED.md),
[QA ledger](E2E01_QA_EVIDENCE.md) and
[Stark trace](E2E01_STARK_GOLDEN_JOURNEY.md) distinguish implemented code,
executed verification, fixture proof, external dependency and independent QA.
Separate audit reports/register were unavailable. G01–G03 were referenced without
definitions; this remediation does not invent their meaning.

Independent review of the initial checkpoint `e841fc800c0808dbc3d8ae0eb114b6f55236fcfc`
returned CHANGES REQUIRED for form authority, numeric claim coverage, historical
rollback, mailbox encoding, country normalization and a masked negative test.
Corrections were independently reviewed against 794c3f4 with a code-review-only GO.

No implementation-complete or independently-accepted claim is made while any
mandatory gate remains missing or failing. Leave the PR unmerged.

## Final functional checkpoint

`794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2`; [draft PR #48](https://github.com/sutherlandamcom/factory/pull/48), unmerged.
Independent exact-SHA code review returned GO; independent executed acceptance
is not claimed. Mandatory OSV and industrial-attribution verification remain open; full technical completion and
READY FOR REVIEW are withheld. Genuine provider evidence for Stark production,
verified project claims and explicit real delivery configuration remain external.

## Authority-chain implementation map

| Producer → consumer | Contract / durable authority | Validation | Execution evidence |
|---|---|---|---|
| Intake acceptance → Search | `ProjectInputSnapshot`, `project_input_snapshots` exact id/version/digest | `ProjectIntakeStore.accept`, `resolveSearchContext`, `SearchService.runSearch` | Stark trace accepted input and fixture search run; context regression tests |
| Search → competitor acquisition → gap acceptance | Search run/snapshot refs, competitor run refs and immutable gap snapshot | Existing Search/competitor/content-gap services and exact reviewed digest acceptance | Built Dashboard journey; accepted brief retains gap id/version/digest |
| Accepted Intake + gaps → writer policy/brief → prompt | Writer policy, brief and prompt snapshot tables, exact lineage refs | `WriterStore`, `WriterService`, snapshot compilation/approval and staleness checks | Stark policy/brief/prompt refs and digests in trace |
| Approved prompt → proposal → accepted content | `PageContentProposalData`, `AcceptedPageContent`; fixture provider recorded | `WriterService.generateProposal`, QA and exact proposal acceptance | Russian fixture proposal/accepted content refs in trace; no live writer claim |
| Accepted content → approved assets/assignments | AssetVersion binary/governance digests plus exact content id/version/digest | `AssetStore`, assignment authority and revocation/staleness gates | Stark assets workspace trace; preserved persistence regressions |
| Accepted content/assets → accepted design | Design input contentRefs/assetRefs, candidate and accepted design digests | `DesignStore`, exact candidate acceptance; `requireProductionDesign` rejects fixture mode | Stark design input/candidate/artifact refs retain fixture mode |
| Accepted design → visual resolution/set → freeze | Visual plan, prompt, candidates, AssetVersion, accepted set and design refs | `VisualStore`, exact prompt/slot/set binding and final design freeze | Stark visual workspace trace; no fixture-to-live conversion |
| Accepted Intake + worktree SiteProfile → production identity | Repository `project-site-binding-v1`, registered project/site/destination, profile/accepted-identity digests | `loadProjectSiteBinding`, `requireProjectSiteAuthority`, `loadProductionBuildIdentity` | Unit/PG isolation, wrong-project, identity/destination mutations |
| Exact content/design/visual/derivatives + identity → ProductionPageInput | Versioned PPI data, conversion copy/destination, snapshot and binding digests | `ProductionStore.deriveProductionInput`, authority bundle, final configuration recheck | Strict fixture rejection in Stark journey; production persistence regressions |
| ProductionPageInput → manifest → Astro | Manifest exact accepted-content ref, conversion/navigation and manifest digest | `ProductionRenderCompiler`, `assertManifest`, contract parser, route checks | Separate isolated renderer fixtures only; no continuous authorized Stark manifest |
| Manifest → candidate bytes → QA | Candidate repository SHA, recursive artifact digest, bound inputs, QA rows | `ProductionBuildService`, `ProductionStore.recordBuild/recordQaRun`, current authority and artifact checks | Mandatory production/PG/browser gates; Stark chain has no candidate artifact beyond rejection |
| Candidate QA → preview/release/recovery | Immutable artifact/version, registered target, exact approval and persisted deployment | `GovernedDeliveryService`, release boundary, historical target resolver/reconciliation | Existing delivery fault/rollback tests; no live provider mutation performed |

For runtime IDs/versions/digests, use the captured trace rather than conflating
separate synthetic renderer fixtures with the accepted Stark operator chain.

## Changed/new files at functional checkpoint

73 paths; A=new, M=modified. No dependencies were added.

```text
M	apps/dashboard/e2e/competitors-gaps-journey.spec.ts
M	apps/dashboard/e2e/content-writer-journey.spec.ts
A	apps/dashboard/e2e/e2e01-stark-golden-journey.spec.ts
M	apps/dashboard/e2e/run11-golden-steps.ts
M	apps/dashboard/e2e/search-gap-helper.ts
M	apps/dashboard/scripts/operator-e2e-server.mjs
M	apps/dashboard/src/api/client.ts
M	apps/dashboard/src/pages/SearchPage.tsx
A	apps/factory/drizzle/0042_search_context.sql
M	apps/factory/drizzle/meta/_journal.json
M	apps/factory/src/delivery/governed-service.ts
M	apps/factory/src/persistence/schema.ts
M	apps/factory/src/persistence/store.ts
M	apps/factory/src/production/api-facade.ts
M	apps/factory/src/production/build-service.ts
A	apps/factory/src/production/conversion.ts
M	apps/factory/src/production/design-implementation.ts
M	apps/factory/src/production/identity.ts
M	apps/factory/src/production/qa/collector.ts
M	apps/factory/src/production/qa/content-integrity.ts
M	apps/factory/src/production/qa/site-wide.ts
M	apps/factory/src/production/qa/trust.ts
M	apps/factory/src/production/render-manifest.ts
A	apps/factory/src/production/site-binding.ts
M	apps/factory/src/production/store.ts
A	apps/factory/src/search/context.ts
M	apps/factory/src/search/search-store.ts
M	apps/factory/src/search/serp-brightdata.ts
M	apps/factory/src/search/service.ts
A	apps/factory/src/text/lexical.ts
M	apps/factory/src/writer/fixture-writer.ts
M	apps/factory/src/writer/qa.ts
M	apps/factory/src/writer/service.ts
M	apps/factory/tests/delivery-rollback-authority.test.ts
A	apps/factory/tests/e2e01-conversion.test.ts
A	apps/factory/tests/e2e01-renderer.test.ts
A	apps/factory/tests/e2e01-review-regressions.test.ts
A	apps/factory/tests/e2e01-search-context.test.ts
A	apps/factory/tests/e2e01-site-binding.test.ts
A	apps/factory/tests/e2e01-unicode.test.ts
A	apps/factory/tests/e2e01-writer-fixture.test.ts
A	apps/factory/tests/fixtures/project-site-binding.ts
M	apps/factory/tests/fixtures/search-gap.ts
M	apps/factory/tests/governed-delivery.test.ts
M	apps/factory/tests/operator/workflow-read-model.test.ts
M	apps/factory/tests/persistence/delivery-fault-injection.test.ts
A	apps/factory/tests/persistence/e2e01-site-binding.test.ts
M	apps/factory/tests/persistence/pre-run12-authority-chain.test.ts
M	apps/factory/tests/persistence/production-persistence.test.ts
M	apps/factory/tests/persistence/run10-golden-seam.test.ts
M	apps/factory/tests/persistence/run10-production-derivatives.test.ts
M	apps/factory/tests/persistence/run12-adversarial-design.test.ts
M	apps/factory/tests/persistence/run12-production-reliability-qa.test.ts
M	apps/factory/tests/persistence/run12-sutherland-multipage.test.ts
M	apps/factory/tests/persistence/run13-sutherland-governed-delivery.test.ts
M	apps/factory/tests/persistence/run13-sutherland-six-page-e2e.test.ts
M	apps/factory/tests/production-qa-gates.test.ts
M	apps/factory/tests/search-brightdata.test.ts
M	apps/factory/tests/search-service.test.ts
A	docs/evidence/E2E01_COMPONENT_API_REVIEW.md
A	docs/evidence/E2E01_ISSUE_REGISTER_RESOLVED.md
A	docs/evidence/E2E01_QA_EVIDENCE.md
A	docs/evidence/E2E01_REMEDIATION_SUMMARY.md
A	docs/evidence/E2E01_STARK_GOLDEN_JOURNEY.md
A	docs/production-project-site-binding.md
M	docs/roadmap-vnext.md
M	packages/contracts/src/index.ts
M	packages/contracts/src/operator-errors.ts
M	packages/contracts/src/production.ts
M	sites/starter/src/components/production/PageCta.astro
M	sites/starter/src/components/production/ProductionPageRenderer.astro
M	sites/starter/src/layouts/ProductionLayout.astro
M	sites/starter/tests/keyboard.production.spec.ts
```

## API and contract behavior

Search now rejects unresolved targeting with typed `search_context_invalid`
before provider execution; its read model exposes effective defaults/readiness
and provenance. Production mutations reject missing or stale trusted binding
with an actionable configuration error. Workspace inspection does not provision
a target. New manifests bind conversion copy/destination, exact accepted-content
reference and profile navigation; contract readers preserve historical rows.

The new/modified test paths are enumerated above. Coverage includes wrong project,
missing binding, identity/target/configuration changes, stale content/design/assets
and QA, source/review revocation, unsupported targeting, Russian/English/empty
intent, unsafe destinations and distinct keyboard stops. The industrial attribution
matrix is explicitly outstanding; semantic factual verification is not claimed.
