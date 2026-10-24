# E2E-01 unified issue register

This register preserves the master-prompt IDs. Separate audit reports and the
original register were not supplied. A status is an execution-evidence claim,
not an inferred acceptance. All changes remain unmerged.

| ID | Priority | Original finding | Root cause | Files changed | Tests | Status | Remaining risk |
|---|---|---|---|---|---|---|---|
| E2E-P0-01 | P0 | Wrong project identity and delivery target | Global rendering profile plus implicit target provisioning lacked project authorization | `production/site-binding.ts`, `identity.ts`, `store.ts`, `build-service.ts`, `api-facade.ts`, `delivery/governed-service.ts` | `e2e01-site-binding`, PG isolation, two isolated renderer fixtures, delivery regression | FIXED — VERIFIED | Explicit real binding still requires operator provisioning; global OSV/readiness failures remain open |
| E2E-P1-01 | P1 | Search language/geography not enforced | Optional form fields and market hints bypassed accepted targeting | `search/context.ts`, `service.ts`, Bright Data adapter, migration 0042, `SearchPage.tsx` | context derivation, overrides, conflict, unsupported targeting, Russia gl/hl, Russian browser journey | FIXED — VERIFIED | Exact-head Russian UI journey and persisted context verified; real provider reachability remains external |
| E2E-P1-02 | P1 | Cyrillic intent false PASS | ASCII tokenization reduced non-Latin intent to an empty string | `text/lexical.ts`, `writer/qa.ts`, `production/qa/trust.ts` | relevant/unrelated Russian/English, empty, mixed script; empty intent REVIEW | FIXED — VERIFIED | Lexical overlap remains advisory alignment, never semantic truth |
| E2E-P1-03 | P1 | Text-only CTA | No exact verified conversion destination in production authority | `production/conversion.ts`, production contracts/compiler/QA, `PageCta.astro`, renderer | unsafe schemes, forms, email encoding, exact anchor/destination, keyboard activation | FIXED — VERIFIED | Forms unsupported; URI validation and internal keyboard activation verified, no live external-contact claim |
| E2E-P1-04 | P1 | Factual provenance concerns at Intake | Intake provenance is not source authority; demonstrated substring path also authorized extra quantities | Unicode trust normalization and quantity coverage check | Russian/English additional-quantity rejection; existing source/review/revocation PG gates | FIXED — TESTING INCOMPLETE | Required durable industrial-attribution matrix NOT VERIFIED; reviewer reproduced subject/action semantic false-positive without a publication bypass |
| E2E-P1-05 | P1 | No continuous Stark golden journey | English-only fixtures and missing project configuration obscured safe boundary | `e2e01-stark-golden-journey.spec.ts`, shared journey helpers, Russian fixture writer, isolated test configuration | Exact-head strengthened local browser journey PASS after isolated target configuration; design_approval_failed rejects fixture promotion | BLOCKED — EXTERNAL DEPENDENCY | Fixture journey cannot create genuine live design/source evidence; no continuous production HTML/artifact/QA for this chain |
| E2E-P1-06 | P1 | Unverified Stark personnel/industrial assertions | Missing independently verified project-source material | No invented claims or evidence added | Explicitly excluded from fixture content and production-approved evidence | NOT A CODE DEFECT | Operator must supply appropriate sources and exact-content review |
| E2E-P2-01 | P2 | First Search query guidance | Readiness/default provenance and accepted hypotheses were unclear | `SearchPage.tsx`, Search read model | Russian accepted defaults and seed/query journey | FIXED — VERIFIED | Search/writer browser fixtures and Stark journey pass; effective provenance also inspected in persisted Search row |
| E2E-P2-02 | P2 | Generic Intake actor | Local single-operator Intake has no authenticated personal identity | Documented current boundary; no fictitious actor | Inspected API acceptance and `acceptedBy: operator` persistence | DOCUMENTED LIMITATION | Release/review authentication does not automatically authenticate Intake |
| E2E-P2-03 | P2 | Profile navigation omitted | Production layout only rendered brand link | compiler/manifest, `ProductionLayout.astro`, site-wide QA | isolated two-route builds, exact navigation/route validation | FIXED — VERIFIED | Two exact-head isolated route sets and 4/4 desktop/mobile keyboard cases verified; only configured routes are authorized |
| E2E-P2-04 | P2 | Lexical factual QA overstated | Deterministic matching cannot establish semantics or independent factuality | QA wording and fail-closed empty/quantity checks; existing human/source gates retained | Exact-SHA reviewer probes demonstrate changed corporate attribution can pass lexical subchecks while overall strict trust without review fails | DOCUMENTED LIMITATION | P2 carried under repository governance; durable industrial-attribution matrix remains NOT VERIFIED; no authority-preserving publication bypass demonstrated |
| E2E-P2-05 | P2 | Merged capabilities shown as future work | Roadmap status lagged merge history | `docs/roadmap-vnext.md` | Verified local merge objects for PRs 43, 45, 46, 47 | FIXED — VERIFIED | Merge evidence is not proof of live provider acceptance |
| G01 | External | Definition unavailable | Master prompt names gate without defining it | This register | NOT VERIFIED | DOCUMENTED LIMITATION | Cannot infer missing gate requirements |
| G02 | External | Definition unavailable | Master prompt names gate without defining it | This register | NOT VERIFIED | DOCUMENTED LIMITATION | Cannot infer missing gate requirements |
| G03 | External | Definition unavailable | Master prompt names gate without defining it | This register | NOT VERIFIED | DOCUMENTED LIMITATION | Cannot infer missing gate requirements |

Paths above are under `apps/factory/src`, `apps/factory/tests`,
`apps/dashboard`, `packages/contracts/src` or `sites/starter/src` as named.
See the QA report for exact commands, results and candidate identity.

Final reviewed checkpoint: `794c3f48e6142ce4ffdebbd3e7c15b896a81fdb2`.
Scoped independent code review: GO; independent executed acceptance: NOT VERIFIED.
The global verdict is **REMEDIATION PARTIAL — VERIFIED FIXES, OPEN BLOCKERS**.
The full local browser suite has 14 PASS/3 FAIL: every failure reports only
`security.osv`. OSV reports seven advisory/package-version rows in the unchanged
lockfile. Passing issue-specific tests does not waive this mandatory blocker.

The P2-04 probes use invented test sentences, not factual assertions about either
company. They do not establish production approval. The P1-04 durable industrial
matrix must still cover supported/unsupported attribution, wrong-project and
changed sources, rewording and revocation; generic trust-suite results do not
substitute for that matrix. No missing audit finding or G01–G03 definition was
invented.
