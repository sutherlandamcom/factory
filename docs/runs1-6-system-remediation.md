# Runs 1–6 authority remediation

This slice repairs the accepted pipeline without changing provider ownership or
Run 7 truth policy. Its baseline is `fa055386315cadebea7d6dacd91c2e130ea4d912`.
Implementation and verification do not constitute independent acceptance.

## Authority and compatibility

Search compiles persisted SERP measurements and separately labelled grounded
research into a bounded deterministic packet. Full source digests remain bound
when prompt material is truncated. Cache runs reference an immutable source run
and retain their own returned/read audit identity; cache queries and digests are
project-scoped. Intelligence evidence references require lowercase SHA-256.

Paid Search stages use the existing Writer reservation lifecycle with a separate
Search ledger and the shared budget lock. Backend-only conservative per-stage
bounds are configured through `FACTORY_SEARCH_SERP_MAX_COST_MICROS`,
`FACTORY_SEARCH_GROUNDED_MAX_COST_MICROS`, and
`FACTORY_SEARCH_ANALYST_MAX_COST_MICROS`. Missing or invalid bounds block paid
execution. Unknown/submitted costs consume the reservation; only explicit trusted
non-submission permits release. Trusted actual overruns remain fully accounted.
Fixture adapters remain deterministic and do not spend.

The shared Gap authority reader retains Run 3's evidence and classification
supersession checks. Writer and Design reuse those checks transitively. Accepted
page versions retain the established project-wide sequence, with one current
version per canonical slug. Exact proposal reacceptance returns its historical
record and never promotes it over a newer accepted page. Accepted history is
available in Writer workspace metadata and the project-scoped accepted-content
read endpoint, and is inspectable from the Content UI.

The explicit no-gap compatibility waiver remains durable and digest-bound on the
bound brief. It does not qualify as full production lineage and cannot enter the
Design authority path. Historical artifacts remain available for inspection.

New asset assignments bind the accepted page ID/version/digest/slug as well as
asset version/binary/governance/role. Legacy slug-only assignments remain
unqualified; their page authority is never inferred by migration. Explicit
replacement may supply `pageAuthority` to bind the current accepted version of
the same slug. Previous bindings are recorded in immutable assignment history.

Project authority writes and downstream acceptance transactions share a
PostgreSQL advisory lock. Provider calls run outside those transactions; Writer
proposal persistence and Design candidate persistence recheck the dependencies
after generation. No approval can be rescued by rewriting accepted history.

## Verification entrypoints

- `tests/persistence/baseline-defects.test.ts` is portable to the original code
  with the corrected fixture setup. Its failing assertions reproduce the
  reported defects, rather than treating setup errors as evidence.
- Search unit regressions cover actual evidence delivery, prompt changes with
  unchanged IDs, exact grounded digest contracts, audit-run identity and cost
  settlement.
- `tests/persistence/system-remediation.test.ts` covers transitive staleness,
  versions, exact joins, no-gap rejection and real PostgreSQL concurrency.
- The Design authority browser journey now acquires Search evidence, reviews and
  accepts Gap decisions, then produces accepted content and assigns the asset to
  that exact page. Fixture design acceptance remains non-production authority.
- `tests/migration-upgrade-proof.ts` verifies a populated baseline migration:
  accepted content is unchanged, legacy assignments receive no inferred page
  binding, and migration replay is idempotent. It consumes the baseline seed
  manifest rather than resetting that database.
- `tests/design-live-proof.ts` is excluded from ordinary CI. With
  `FACTORY_DESIGN_LIVE_PROOF=1` and a qualified
  `FACTORY_LIVE_PROOF_PROJECT_ID`, it executes one production
  `DesignService.generateCandidate()` call, resolving accepted copy itself.
  It requires exact accepted content/assets and at most three archetypes, does
  not retry, and leaves the live candidate pending human design review.

Final command results and the immutable candidate SHA belong in the PR report.
Required gates remain `pnpm qa`, persistence, Operator API security and built
Dashboard browser E2E; a passing subset is not full acceptance.

## Recorded development evidence

Baseline `fa055386315cadebea7d6dacd91c2e130ea4d912`, with only portable regression
and fixture files copied in: Search service/contracts plus baseline defects ran
48 tests: 38 passed, 10 expected assertion failures, zero skips, exit 1.
Failures covered absent evidence/actual prompt changes, malformed digest,
cache audit identity, unknown cost, stale Writer, waiver Design qualification,
same-slug acceptance, stale Design, and invented page assignment.
The additional DataForSEO task-cost regression failed before the adapter fix
(`requestSubmitted` was undefined), then passed with reported actual cost retained.

Focused checks after remediation: Search/provider/contracts/budget 71 passed,
zero failed/skipped; portable defects and system PostgreSQL tests 14 passed,
zero failed/skipped. The built Design authority journey passed with exact joins
and service restart. These are development evidence, not the final gate results.

The one live Stitch service execution completed successfully, with no retries.
It used the real persisted browser journey project with deterministic upstream
providers and a nonempty accepted-copy mapping. This is live Design provider
execution evidence, not live Search/Writer evidence or human design acceptance.
The candidate remains pending human design review. No second live execution is
authorized by these test scripts; the final automated gates use fixtures only.

```json
{"candidateId":"dsn-2855b6c8-1890-424e-b3f0-cb9c665b5aed","candidateDigest":"5a29664e194de1b693fd4203dbf0be04d9de723b8a5a269c5d153bfb7240560c","inputSnapshotId":"dsi-59c61fd3-01c1-4df3-912b-2d87dd6ca154","inputDigest":"ef336a6c37b33ebe958d84436c069e65d9ccb901f98ce331fb260a0d68ea6c37","contentRefs":[{"id":"wacc-a7e78899-e630-4a74-9f4c-d0da74cdce5e","version":1,"slug":"roof-repair-austin","contentDigest":"e17c609be931c96147125c89fb284f11895ac5fa0057a53b026b14456f71591a"}],"assetRefs":[{"versionId":"asv-9d008f0b-0280-46b9-b943-f231e75b5488","binaryDigest":"d18f0d6d72576eff65c61828a5a4d8c8053edf159e5c890f44d695afab559a48","acceptedPageContentId":"wacc-a7e78899-e630-4a74-9f4c-d0da74cdce5e","acceptedPageContentVersion":1,"acceptedPageContentDigest":"e17c609be931c96147125c89fb284f11895ac5fa0057a53b026b14456f71591a","governanceDigest":"f71d9d19abfcf7bf2c7fdc965a70fb553076984c5eb5a1533a2ee164badf58d6","pageSlug":"roof-repair-austin","role":"hero"}],"authority":"production service; pending human design acceptance"}
```
