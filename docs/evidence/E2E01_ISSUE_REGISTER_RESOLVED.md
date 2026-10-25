# E2E-01 unified issue register

This register preserves the master-prompt IDs. A status is an execution-evidence
claim, not an inferred acceptance. Changes stage: integrated remediation MERGED
to `main` via PR #48 (merge commit `16b0b95…`); the adversarial final-remediation
round (P1-A/B/C below) lives on branch `fix/e2e01-final-remediation`
(candidate `d479512…`) pending its PR; a user-authorized agent-merge exception
is recorded in the remediation summary.

FINAL-STAGE additions to the register (branch `fix/e2e01-final-remediation`):

| ID | Priority | Finding | Root cause | Files changed | Tests | Status | Remaining risk |
|---|---|---|---|---|---|---|---|
| E2E-P1-A | P1 | Cross-SourceRef evidence fusion: a joined `.join(" ")` excerpt blob let an actor fragment in one ref + verb/figure fragment in another falsely substantiate a claim; numeric figures from an unrelated ref laundered support for the pairing ref | `claimLineageProblems` used a single combined blob for numeric/lexical/attribution checks | `packages/contracts/src/trust-governance.ts` (per-ref units: figuresWithEvidence + actorActionAlignmentProblems), `apps/factory/tests/e2e01-sourceref-isolation.test.ts` | F-01..F-06 RED→GREEN (7/7); probe battery A1/A2/A5 FAIL-closed | FIXED — VERIFIED (`d479512`) | Per-ref semantics now also REQUIRED for any future multi-ref claim producer |
| E2E-P1-A2 | P1 | Numeric-attribution laundering (remaining P1-A defect): the numeric gate accepted a claim figure when ANY cited ref contained SOME actional pairing — "Funding Group invested 500 million" (its own pairing) substantiated "Vendor Ltd performed engineering … worth 500 million" | `claimPairIndicators` tested "any pairing in this ref", not "the CLAIM's actor/action pairing in this ref" | `packages/contracts/src/trust-governance.ts` (`refUnitSupportsClaimPairing`: figures bind to refs pairing the CLAIM's actor/action [family + actor containment + quoted-object containment]; legacy any-pairing gate retained only for claims with no substantive pairing of their own) | NA-01..05 RED→GREEN (brief's exact case + actor/action/object/multi-figure variants), NA-06..08 positive controls, NA-09/10 regression locks; full battery 59/59; Factory 1221/1221; persistence 474/474 | FIXED — VERIFIED | Deterministic pairing matcher (no NLP engine); novel verb families outside the six families fall back to the lexical/number gates by design |
| E2E-P1-B | P1 | Dead negation guard for Cyrillic: `/\b(?:не|нет)\b/` uses ASCII-only `\b` (never matches Cyrillic) — negated RU evidence could pass accidentally via stopword windows; EN "did not invest"/"Not X but Y built" false-PASSED outright; distance negation beyond 12 chars missed; hyphenated/comma-inserted «не …» unbaked | JS regex `\b` is ASCII-only; guard window 12 chars, no do-support, no anti-attribution inversion | same file (`negatedCyrillic`/`negatedEnglish`, 40-char window, insertion tolerance, empty-actor drop), `apps/factory/tests/e2e01-negation.test.ts` | 16 cases RED→GREEN; probes A3a/A3c were confirmed BYPASSES then closed; A3b/A4b over-suppression positive locks added | FIXED — VERIFIED (`d479512`) | Deterministic token-level guard only; no general NLP negation engine (deliberate scope per anti-over-engineering rule) |
| E2E-P1-C | P1 | Source-ownership transplant risk: can B gain production authority using verbatim A `intake:` refs? | — (boundary audit, no code change needed) | `apps/factory/tests/persistence/e2e01-source-transplant.test.ts` (additive probes) | TP-01..03 on isolated Phase 3 PG: A rows invisible to B, A review never crosses, verbatim transplant leaves B review-less; production-QA trust path re-verified | NO BYPASS PROVEN — probes added on top of XP-01..08; boundary documented | boundary holds at per-project rows + digest-bound reviews; future providers must keep intake refs per-project |
| E2E-P1-A8 | P1 | calculationRef figure laundering into FIRST_PARTY_FACT claims | calculationRef figures counted regardless of claimType | same file (CALCULATION-only gate + `calculation_ref_claim_type_mismatch`) | probe A8 closed; CALC-16 lock | FIXED — VERIFIED (`d479512`) | Existing suites already bound calcRefs to CALCULATION claims; rule is strictly additive |
| E2E-P2-MERGE | P2 | No real-inference path: Factory could execute paid models ONLY through OpenRouter; the accepted AI provider contract did not include Merge Gateway | Single-gateway adapter + `modelGatewaySchema = z.enum(["openrouter"])` | `apps/factory/src/models/merge-gateway.ts` (NEW adapter, same contracts/failure taxonomy), `apps/factory/src/models/merge-policy.ts` (NEW test-only pilot profile), `packages/contracts/src/site-blueprint.ts` (additive enum "merge"), `apps/factory/src/models/pricing.ts` (verified `zai/glm-5.3-flash` ceiling), wiring in `operator/server.ts`, `competitors/service.ts`, `writer/provider.ts` + provenance fix in `writer/service.ts` | MG-01..18 deterministic fail-closed battery (19/19, zero network); LIVE-MODEL smoke PASS (real `zai/glm-5.3-flash` call: 112 tokens, $0.00001232 reported); authenticated per-key preflight (314 models, GLM `available`, `access_required: false`; first-page listing without pagination returned only 50 — adapter now walks the cursor) | FIXED — VERIFIED (adapter + LIVE-MODEL) / PARTIAL — writer strict-JSON gate rejected the pilot's rich-content format fail-closed (correct governance behavior, budget ledger: merge/1657µ) | Pilot is test-only (no publication authority), requires `FACTORY_LLM_PROVIDER=merge` + `MERGE_GATEWAY_API_KEY`; production champions unchanged; assertOverrideStartupPolicy untouched; SERP/Stitch/Visual providers NOT replaced (G01 remains) |

External gate definitions (restored from the original unified issue register;
the previous PR report lacked them because the original audits were not
supplied to that agent):

| ID | Definition | Closing evidence |
|---|---|---|
| E2E-G01 | Real Russian SERP, Writer, Stitch and Visual provider execution, including behavior and cost | Explicitly authorized live provider pilot and actual evidence |
| E2E-G02 | Real Cloudflare preview, production and rollback at the correct route/target | Authorized controlled deployment and verified domain/worker |
| E2E-G03 | Stark legal, brand, client, intellectual-property, photography and claim authority | Primary documents and legitimate human approval |

## P0/P1/P2 register

| ID | Priority | Original finding | Root cause | Files changed | Tests | Status | Remaining risk |
|---|---|---|---|---|---|---|---|
| E2E-P0-01 | P0 | Wrong project identity and delivery target | Global rendering profile plus implicit target provisioning lacked project authorization | `production/site-binding.ts`, `identity.ts`, `store.ts`, `build-service.ts`, `api-facade.ts`, `delivery/governed-service.ts`; fixture delivery default aligned with binding site-profile origin | `e2e01-site-binding` (unit+PG), browser isolation journeys, two isolated renderer fixtures, run13 preview/publish/rollback browser journey (17/17) | FIXED — VERIFIED | Explicit real binding still requires operator provisioning; no automatic site onboarding |
| E2E-P1-01 | P1 | Search language/geography not enforced | Optional form fields and market hints bypassed accepted targeting | `search/context.ts`, `service.ts`, Bright Data adapter, migration 0042, `SearchPage.tsx` | context derivation, overrides, conflict, unsupported targeting, Russia gl/hl, persisted `search_runs.request_context`; browser units 55/55 incl. service+adapter | FIXED — VERIFIED | Real provider reachability remains external (E2E-G01) |
| E2E-P1-02 | P1 | Cyrillic intent false PASS | ASCII tokenization reduced non-Latin intent to an empty string | `text/lexical.ts`, `writer/qa.ts`, `production/qa/trust.ts` | relevant/unrelated Russian/English, empty, mixed script; empty intent REVIEW; unit suites 52/52 | FIXED — VERIFIED | Lexical overlap remains advisory alignment, never semantic truth (P2-04) |
| E2E-P1-03 | P1 | Text-only CTA | No exact verified conversion destination in production authority | `production/conversion.ts`, production contracts/compiler/QA, `PageCta.astro`, renderer | unsafe schemes, forms, email encoding, exact anchor/destination, keyboard activation; unit suites 52/52; real Astro renderer 2/2 | FIXED — VERIFIED | Forms unsupported; no live external-contact claim |
| E2E-P1-04 | P1 | Industrial claim attribution | Lexical/number matching could not bind actor or action; the same figure could substantiate an unsupported actor; the recognizer was English-only so Russian-language misattribution went unchallenged; the former "wrong-project" unit probe falsely implied cross-project rejection | `packages/contracts/src/trust-governance.ts` (actorActionAlignmentProblems + RU family patterns/negation/tense/object binding/evidence isolation), `tests/e2e01-industrial-attribution.test.ts`, `tests/persistence/e2e01-industrial-attribution.test.ts`, `tests/persistence/e2e01-cross-project-authority.test.ts` | EN+RU matrix 24/24 exec; PG cross-project/XP suite 6 scenarios; full persistence 467/467 at candidate | FIXED — VERIFIED (boundary semantics documented) | Attribution authority: (1) actor/action+object binding including RU, enforced at lineage verdict; (2) intake-class SourceRefs are convention strings — NOT persisted project-owned records: cross-project rejection provably lives at per-project trust rows, digest-bound reviews and `cross_project_audit_event_rejected`, NOT at ref strings; false old test corrected to the documented boundary; matrix uses fictional entities only (P1-06/G03) |
| E2E-P1-05 | P1 | No continuous Stark golden journey | English-only fixtures and missing project configuration obscured safe boundary | `e2e01-stark-golden-journey.spec.ts`, shared journey helpers, Russian fixture writer, isolated test configuration | exact-head browser 17/17 incl. Stark fixture journey ending at the correct `design_approval_failed` boundary | FIXED — VERIFIED (fixture tier) / BLOCKED — EXTERNAL DEPENDENCY (real-provider tier) | Fixture journey cannot create genuine live design/source evidence; real-provider chain stays behind E2E-G01/G02/G03 |
| E2E-P1-06 | P1 | Unverified Stark personnel/industrial assertions | Missing independently verified project-source material | None — no invented claims or evidence added | None; production approval path refuses unverified claims | NOT A CODE DEFECT — PRIMARY SOURCE AND HUMAN APPROVAL REQUIRED | Operator must supply appropriate sources and exact-content review (G03) |
| E2E-P2-01 | P2 | First Search query guidance | Readiness/default provenance and accepted hypotheses were unclear | `SearchPage.tsx`, Search read model | Russian accepted defaults and seed/query journey (browser 17/17) | FIXED — VERIFIED | Effective provenance inspected in persisted Search row |
| E2E-P2-02 | P2 | Generic Intake actor | Local single-operator Intake has no authenticated personal identity | Documented current boundary; no fictitious actor | Inspected API acceptance and `acceptedBy: operator` persistence | DOCUMENTED LIMITATION | Release/review authentication does not authenticate Intake |
| E2E-P2-03 | P2 | Profile navigation omitted | Production layout only rendered brand link | compiler/manifest, `ProductionLayout.astro`, site-wide QA | isolated two-route builds 2/2, exact navigation/route validation | FIXED — VERIFIED | Only configured routes are authorized |
| E2E-P2-04 | P2 | Lexical factual QA overstated | Deterministic matching cannot establish semantics or independent factuality | QA wording and fail-closed empty/quantity checks; new P1-04 actor/action alignment narrows the exploit surface | matrix L1 explicitly documents same-number/different-actor lexical overlap while L2/L3 refuse authorization | DOCUMENTED LIMITATION (narrowed) | Lexical overlap remains advisory; full attribution authority requires sources+review, already enforced |
| E2E-P2-05 | P2 | Merged capabilities shown as future work | Roadmap status lagged merge history | `docs/roadmap-vnext.md` | Verified local merge objects for PRs 43–47 | FIXED — VERIFIED | Merge evidence is not proof of live provider acceptance |
| E2E-G01 | External | Real Russian SERP, Writer, Stitch and Visual provider execution, including behavior and cost | Requires explicitly authorized live provider pilot | None | NOT VERIFIED — local/fixture execution does not close this gate | BLOCKED — EXTERNAL DEPENDENCY | Do not close through local fixtures |
| E2E-G02 | External | Real Cloudflare preview, production and rollback at the correct route/target | Requires authorized controlled deployment and verified domain/worker | None | NOT VERIFIED — test-only delivery control flow (mock/simulated wrangler) does not close this gate | BLOCKED — EXTERNAL DEPENDENCY | Do not close through local fixtures |
| E2E-G03 | External | Stark legal, brand, IP, photography and claim authority | Requires primary documents and legitimate human approval | None | NOT VERIFIED — P1-06 stays outside production-approved content | BLOCKED — EXTERNAL DEPENDENCY | Do not close through invented source evidence |

Paths above are under `apps/factory/src`, `apps/factory/tests`, `packages/contracts/src`,
`apps/dashboard` or `sites/starter/src` as named. See the QA report for exact
commands, results and candidate identity.

Final candidate: **`b44ec640706bb0a271ec1e6f6ca398f4449edb97`** (exact local battery:
`pnpm check` exit 0; `pnpm qa` Factory 1167/1167 + Dashboard 51/51 + site
35 pass/35 conditional skips; persistence 467/467 on a real isolated
PostgreSQL 18 cluster; operator 149/149; production 60/60; browser 17/17;
axe 8 pass/8 duplicate-combination skips; keyboard 8/8; Lighthouse PASS
(12 runs); gitleaks clean (328 commits); `osv-scanner` exit 0, scanner
config byte-unchanged). The previous final SHA
`49a223c2e1df56c2f18e7b6a9c3a951560454f85` (CI run `40128660807`) is
SUPERSEDED: it carried the EN-only attribution matrix and the overstated
wrong-project claim corrected by the P1-04 update above (RU-01..15, RUX-01,
PG-RU persistence and XP-01..08 are new at `b44ec64`).

The P2-04 lexical probes use invented test sentences, not factual assertions
about either company. No missing audit finding was invented; G01–G03 carry the
restored original definitions above.

### Battery supersession at the final-remediation + Merge-pilot candidate

Battery re-executed fresh at the candidate recorded at the bottom of
`E2E01_QA_EVIDENCE.md`: `pnpm check` exit 0; Factory 1221/1221 (+10 P1-A2,
+19 Merge); Dashboard 51/51; site Playwright 35 passed / 35 conditional skips;
persistence 474/474 (real isolated PostgreSQL 18 `factory_test`);
operator 149/149; production-path 60/60; full build exit 0; gitleaks clean
(`--redact`, 334 commits); `osv-scanner` exit 0 (`No issues found`,
Unfiltered Vite dev-server advisories remain scoped in `osv-scanner.toml`).
