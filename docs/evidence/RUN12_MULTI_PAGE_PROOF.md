# Factory Run 12 — High-Quality Multi-Page Sutherland Proof

## A. Executive Summary

Run 12 proves that Factory produces a real, coherent, trustworthy, useful, technically valid, multi-page Sutherland website (`Sutherland Private Office`) through the governed end-to-end Factory pipeline:

```text
Accepted Project Inputs (primary-source French Alpine evidence ledger)
→ Search Intelligence (Run 2 — real SearchIntelligenceService over acquired SERP corpus)
→ Competitor / Content-Gap Authority (Run 3 — real CompetitorContentGapService over 6 acquired competitor snapshots & analyses)
→ Durable PageIntentAuthority & Anti-Cannibalization Gate
→ Writer Policy + Atomic Content Brief & PageArchetypeAuthority (PR #45)
→ Writer Prompt Snapshot + Governed Writer Proposal + Deterministic Content QA
→ AcceptedPageContent (grounded in INSEE RP2022, DGFiP DVF/IFI, Notaires de France, Ville de Chamonix PLU, Géorisques PPRN, Cour des comptes, and Loi Hoguet)
→ Project DesignInputSnapshotV2 + Single AcceptedDesignArtifact (design-v2)
→ Deterministic DesignImplementationContract (design-implementation-v1)
→ VisualService Plan / Classification / Reuse / AcceptedVisualAssetSet (kind: "illustration")
→ ProductionPageInput (PPI)
→ ProductionRenderCompiler (production-v3 manifests with projected ReviewAuthorityAttribution)
→ Astro 7 Static Build + Root Redirect Stub + Sitemap/Robots + Visible [data-review-authority] Attribution
→ Mandatory YMYL Trust Governance Gate inside ProductionApiFacade.runCandidateQa & ProductionStore.recordQaRun
→ Real-Browser Playwright E2E / Responsive / Axe / Keyboard / Lighthouse QA + Persisted Build & Screenshot Artifacts
```

All mandatory blocks (Blocks 0–63) and all P1-1..P1-6 and P2-1..P2-6 review findings are implemented, deterministically tested against PostgreSQL 18 and the built Astro output, and verified against adversarial YMYL and design-governance failure cases.

---

## B. Pre-Flight & Baseline Proof (Block 0)

- **Repository**: `https://github.com/sutherlandamcom/factory`
- **Accepted Baseline (`origin/main`)**: `3e93227ca9f78ffaa5f460ef6dc914f9f1e873b3`
- **Merged Prerequisite PR**: `#45` (`MERGED`, candidate commit `61de799ef8b27707a7b2a4c6d805ce1a60e59d95`)
- **Post-Merge CI Run on Accepted Main**: `35843221081` — `completed` / `success`
- **Run 12 Branch**: `feat/run12-multipage-proof` (branched directly from `3e93227ca9f78ffaa5f460ef6dc914f9f1e873b3`)
- **Untracked User File Preservation**: `diff.txt` preserved untouched outside Git index.

---

## C. Site Scope & Sixth-Page Archetype Decision (Block 2)

### Mandatory 5 Production Pages (Initial Site Build)
1. **Homepage**: `/home` (with governed root redirect stub at `/` -> `/home`) — archetype `homepage`
2. **Service**: `/services/buyer-side-advisory` — archetype `service`
3. **Location**: `/locations/chamonix` — archetype `location`
4. **Investment / Advisory**: `/advisory/investment-decision-framework` — archetype `investment_advisory`
5. **Editorial / Research**: `/research/alpine-decision-framework` — archetype `editorial`

### Sixth Page / Post-Design Reuse Proof (`/research/chamonix-supply-notes`) & About-Page Limitation
- **Supported Archetype Vocabulary (`DESIGN_ARCHETYPE_KINDS` in `packages/contracts/src/design.ts`)**:
  `["homepage", "service", "location", "editorial", "investment_advisory"]`
- **Deterministic Rule Evaluation (Block 2)**:
  - The repository contract does **not** include an `about` archetype, and Block 2 strictly forbids inventing an `about` archetype during Run 12.
  - Therefore, a standalone `About / Expert` archetype page is omitted and documented per Block 2's `ELSE` branch, while organization and creator/reviewer identity are surfaced visibly across the 5 mandatory pages and in truthful `Organization` / `WebSite` / `WebPage` structured data.
  - For the **Fifth-Page / Post-Design Reuse Proof (Block 33)**, a 6th production page (`/research/chamonix-supply-notes`) is added under the already-accepted `editorial` archetype after project design acceptance, proving zero new `DesignProvider` calls, zero new `AcceptedDesignArtifact` records, and zero new component/token families.

---

## D. Page Strategy from Real Search & Content-Gap Services (Block 3 / P1-1)

Executed end-to-end through `SearchIntelligenceService` (Run 2) and `CompetitorContentGapService` (Run 3) in `apps/factory/tests/fixtures/sutherland-seeds.ts` over the acquired Sutherland SERP (`6` organic results: `athenaadvisers.com`, `knightfrank.com`, `savills.com`, `home-hunts.com`, `AlpinePropertyIntelligence`, `jll.fr`) and French Alpine institutional corpus (`.factory/blueprint/20260901T114820Z-8976f5e5/normalized-research.json`):
- **Real Persisted Search Artifacts**: `SearchRun` -> `SerpSnapshot` (`6` organic results, computed `snapshotDigest`) -> `SearchIntelligenceSnapshot` (`4` query clusters, `4` semantic coverage requirements, `3` user needs) -> `SearchReview` (`approved`).
- **Real Persisted Competitor & Gap Artifacts**: `CompetitorRun` (`6` persisted `CompetitorPageSnapshot` rows with extracted segments + `6` validated `CompetitorPageAnalysis` rows) -> `ContentGapReport` (`5` evidence-backed gaps across `CoverageMatrixRow[]`) -> `5` recorded `REQUIRED` gap decisions -> `AcceptedContentGapSnapshot` (`5` accepted gaps, computed `snapshotDigest`).

| Route | Page Identity | Archetype | Primary User Intent | Primary Query Cluster | Content-Gap Purpose | Site Role | Target Audience | Main User Task | Primary Conversion / Next Action | Internal Links Out | YMYL Classification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/home` (and `/`) | `home` | `homepage` | Evaluate who should support a consequential French Alps property decision | Independent buyer-side advisory (French Alps) | Entity establishment + commercial-investigation orientation | Homepage: identity and orientation | International buyers evaluating a consequential French Alps property decision | Decide whether independent advisory fits the decision | Understand how an engagement begins (Mode B prose) | `—` (brand shell nav) | `YMYL_INFORMATIONAL` |
| `/services/buyer-side-advisory` | `services/buyer-side-advisory` | `service` | Evaluate the buyer-side advisory service scope and engagement model | Independent buyer-side advisory (French Alps) | Service differentiation: what the engagement does and does not do | Service evaluation | Buyers comparing independent advisory against listing intermediaries | Decide whether to engage the advisory service | Understand how an engagement begins (Mode B prose) | `research/alpine-decision-framework` | `YMYL_INFORMATIONAL` |
| `/locations/chamonix` | `locations/chamonix` | `location` | Understand advisory support for a Chamonix property decision | Location market understanding (Chamonix / Megève) | Geographic service relevance grounded in INSEE, PLU, and Géorisques location facts | Location relevance | Buyers considering Chamonix or Megève specifically | Decide how the advisory supports a Chamonix purchase | Understand how an engagement begins (Mode B prose) | `services/buyer-side-advisory` | `YMYL_INFORMATIONAL` |
| `/advisory/investment-decision-framework` | `advisory/investment-decision-framework` | `investment_advisory` | Use a framework to structure an alpine property investment decision | Decision methodology / evidence-led analysis | Financial decision support with explicit assumption/forecast separation and statutory benchmarks | Decision support | Buyers weighing a financial decision on alpine property | Structure an investment decision with labelled uncertainty | Understand how an engagement begins (Mode B prose) | `research/alpine-decision-framework` | `YMYL_DECISION_SUPPORT` |
| `/research/alpine-decision-framework` | `research/alpine-decision-framework` | `editorial` | Study the evidence-led decision framework and its methodology | Decision methodology / evidence-led analysis | Original analytical value: reproducible framework + labelled calculation + primary source audit | Research credibility | Buyers and researchers evaluating alpine property decisions | Evaluate the framework's methodology and apply its structure | Understand how an engagement begins (Mode B prose) | `services/buyer-side-advisory`, `advisory/investment-decision-framework` | `YMYL_DECISION_SUPPORT` |
| `/research/chamonix-supply-notes` | `research/chamonix-supply-notes` | `editorial` | Read primary-source supply-side observations for Chamonix-Mont-Blanc | Location market understanding (Chamonix / Megève) | Commune-specific supply analysis grounded in INSEE RP2022, Chamonix PLU, and Géorisques PPRN | Supply-side research note | Buyers and researchers auditing physical and regulatory supply constraints in Chamonix-Mont-Blanc | Audit physical stock age, municipal rental quotas, and natural hazard constraints in Chamonix | Understand how an engagement begins (Mode B prose) | `research/alpine-decision-framework`, `services/buyer-side-advisory` | `YMYL_DECISION_SUPPORT` |

---

## E. Cannibalization Matrix & Verdict (Block 4)

Enforced deterministically by `checkCannibalization(intents)` in `packages/contracts/src/trust-governance.ts` and `TrustGovernanceStore.cannibalizationVerdict(projectId)`:

- **Decision Roles**:
  - `home` -> `NAVIGATIONAL_BRAND`
  - `services/buyer-side-advisory` -> `COMMERCIAL_SERVICE_EVALUATION`
  - `locations/chamonix` -> `GEOGRAPHIC_SERVICE_RELEVANCE`
  - `advisory/investment-decision-framework` -> `FINANCIAL_DECISION_SUPPORT`
  - `research/alpine-decision-framework` -> `INFORMATIONAL_RESEARCH`
  - `research/chamonix-supply-notes` -> `INFORMATIONAL_RESEARCH` (distinct primary query cluster `Location market understanding (Chamonix / Megève)` and distinct primary intent `Read primary-source supply-side observations for Chamonix-Mont-Blanc`, with zero duplicated section headings or section bodies against `research/alpine-decision-framework`)
- **Observed Cannibalization Verdict**: `PASS` (`0` pair findings across all 15 page pairs in the 6-page site; adversarial duplicate pair `services/a` + `services/b` deterministically returns `FAIL`).

---

## F. YMYL Classification Table (Block 5)

| Page Identity | YMYL Classification | Rationale from Actual Page Content |
| :--- | :--- | :--- |
| `home` | `YMYL_INFORMATIONAL` | Introduces the practice positioning, Loi Hoguet statutory distinction, and INSEE 2022 commune housing baselines without individualized financial calculations. |
| `services/buyer-side-advisory` | `YMYL_INFORMATIONAL` | Explains advisory engagement scope, Notaires de France 10-day cooling-off and DPE 2023/2025/2034 audit rules, and Loi Hoguet non-intermediation boundaries. |
| `locations/chamonix` | `YMYL_INFORMATIONAL` | Frames Chamonix (`COM-74056`) vs Megève (`COM-74173`) INSEE 2022 stock/vintage, Chamonix PLU servitudes, May 2025 rental rules, and Géorisques PPRN hazard screening. |
| `advisory/investment-decision-framework` | `YMYL_DECISION_SUPPORT` | Structures financial/investment decision-making using DGFiP 5-year DVF deeds, `1,300,000 EUR` / `800,000 EUR` IFI thresholds, DPE capex assumptions, and the `7.2%` illustrative gross equity yield calculation (distinguished from net return). |
| `research/alpine-decision-framework` | `YMYL_DECISION_SUPPORT` | Publishes the four-step analytical verification methodology across INSEE, DGFiP DVF/IFI, Notaires de France DPE, Géorisques PPRN, and the `26400 EUR / 366000 EUR = 7.2%` illustrative gross equity yield calculation (with net return simulated at `4.3%`). |
| `research/chamonix-supply-notes` | `YMYL_DECISION_SUPPORT` | Publishes commune-specific supply-side analysis for Chamonix-Mont-Blanc (`14,538` dwellings, `58.5%` 1946–1990 stock of pre-2020 main residences, Chamonix PLU `25%` social-mix quotas and servitudes, May 2025 rental cap). |

---

## G. Organization Trust Authority (Block 6)

- **Brand / Operating Name**: `Sutherland Private Office`
- **Business Activity**: Independent buyer-side property advisory for consequential property decisions in the French Alps (Chamonix and Megève).
- **Engagement Posture (Mode B)**: No unverified phone number, street address, company registration number, regulatory license, or client list is invented. Engagement initiation is explained truthfully in visible prose (Mode B), and organization identity (`Sutherland Private Office`, `https://sutherlandam.com/`) is visibly rendered in header/footer and projected truthfully into `Organization`, `WebSite`, and `WebPage` JSON-LD.

---

## H. Creator / Expert Authority (Block 7)

- **Responsible Creator & Reviewer**: `Alistair Sutherland` (`creator-alistair-sutherland`, Principal, Buyer-Side Alpine Property Advisory, `Sutherland Private Office`).
- **Topic ↔ Expertise Alignment**: Enforced via `checkTopicExpertiseMatch(requiredDomains, expertiseStatement)` in `packages/contracts/src/trust-governance.ts`. All YMYL decision-support pages bind to `French Alps buyer-side property advisory, INSEE/DVF municipal market analysis, PLU/PPRN due diligence, and investment decision methodology`.

---

## I. Credential & Reputation Evidence Matrix (Block 8)

- **Credential Publication Rule (`credentialPublishable`)**: Any personal or regulatory credential requires a non-empty verifiable `evidenceRef`.
- **Sutherland Run 12 Status**: Zero personal credentials (e.g., CFA, RICS) or regulatory licenses are claimed in accepted inputs; therefore **zero** unverified credentials or awards are published on any page.
- **Conflict-of-Interest Disclosure (`checkConflictDisclosure`)**: Every page explicitly discloses that Sutherland Private Office acts on the buyer side, holds no listing inventory, and does not broker transactions for seller commissions under Loi Hoguet (Law No. 70-9 of 2 January 1970).

---

## J. Review Authority, Visible Attribution & Staleness (Block 9 / P1-4)

- **Durable Table**: `review_authorities` (`apps/factory/drizzle/0034_trust_governance.sql`).
- **Digest Binding & Manifest Projection**:
  - Each `ReviewAuthority` record binds `reviewerRef` (`creator-alistair-sutherland`), `reviewerName` (`Alistair Sutherland`), `reviewerRole` (`Principal, Buyer-Side Alpine Property Advisory`), `reviewerExpertise`, `reviewedAt`, and `reviewedContentDigest` (exact SHA-256 of the accepted page content).
  - `ProductionRenderCompiler.compile` projects `reviewAuthority: ReviewAuthorityAttribution` into `ProductionRenderManifest`, and `ProductionPageRenderer.astro` renders a visible attribution block with `data-review-authority="Alistair Sutherland"` and `data-reviewed-digest="<sha256>"`.
- **Mandatory HTML & DB Verification (`trust.review_authority`)**:
  - `runTrustQa` never skips `trust.review_authority` on `YMYL_DECISION_SUPPORT` or `YMYL_HIGH_IMPACT` pages: missing DB review, stale `reviewedContentDigest`, topic-expertise mismatch, missing visible `data-review-authority` in HTML, or mismatched `data-reviewed-digest` deterministically returns `FAIL`.

---

## K. Claim Classification, Citation Entailment & Full Copy Coverage (Blocks 10–13 / P1-3)

Every material sentence in published page copy across all 6 production pages is verified by `runTrustQa`:
- **Contract-Level Provenance & Entailment (`claimLineageVerdict`)**:
  - Every `SourceRef` must explicitly carry `entailment: "SUPPORTED"` (missing or `"UNSUPPORTED"` fails closed).
  - Every `SourceRef` must carry a non-empty `supportingExcerpt` (`>= 12` chars).
  - Every `TIER_A` / `TIER_B` source requires verified provenance (`sourceUrl` or recognized statutory/statistical/institutional/first-party reference).
  - Every claim must share at least 2 significant lexical tokens with its `supportingExcerpt`s, and every numeric token in a factual/assumption/scenario claim must appear in its `supportingExcerpt`s.
- **Full Material Assertion Coverage (`trust.claim_lineage` & `trust.source_authority`)**:
  - `extractMaterialSentences` scans `introduction`, `sections[*].body`, and `conclusion` on every page for any sentence containing numbers or statutory/statistical/financial assertions (`INSEE`, `DGFiP`, `DVF`, `PLU`, `PPRN`, `DPE`, `IFI`, `Notaires`, `Géorisques`, `Cour des comptes`, `Loi Hoguet`, `Law No.`, `carte professionnelle`, `secondary residences`, etc.).
  - Every material sentence must be covered by a `ClaimLineage` record whose `claimText` appears in the built page HTML. Uncovered material assertions in page prose deterministically fail `trust.claim_lineage`.

---

## L. Original Value & Helpful Content Gate (Blocks 14, 15, 19, 20 / P1-5)

- **Durable Table**: `original_value_records` (`TrustGovernanceStore.saveOriginalValue`).
- **Non-Declarative Verification (`trust.original_value`)**:
  - For `YMYL_DECISION_SUPPORT` and `YMYL_HIGH_IMPACT` pages, `OriginalValueRecord` must bind a valid `lineageClaimId` present in the page's verified `ClaimLineage` set and at least 2 concrete `verifiableAnchors` (`>= 3` chars each) that are verified to appear verbatim in the built HTML page. Declarative-only records without `lineageClaimId` or HTML-verified anchors deterministically return `FAIL`.

---

## M. Mandatory YMYL Gate in Production Candidate Lifecycle (P1-6)

- **Registry Contract (`REQUIRED_TRUST_QA_GATES` in `apps/factory/src/production/qa/registry.ts`)**:
  - Exports all 10 trust QA check IDs:
    1. `trust.ymyl_classified` (site)
    2. `trust.cannibalization` (site)
    3. `trust.claim_lineage` (page)
    4. `trust.calculation_reproducible` (page)
    5. `trust.source_authority` (page)
    6. `trust.original_value` (page)
    7. `trust.ymyl_elements` (page)
    8. `trust.review_authority` (page)
    9. `trust.date_honesty` (page)
    10. `trust.numerical_discipline` (page)
  - `assertCompleteTrustQa(checks, indexableRoutes)` verifies that every site-scoped trust gate is present and `PASS`, and every page-scoped trust gate is present for every indexable route and `PASS` (neither `FAIL` nor `REVIEW` is accepted as publish-eligible).
- **Lifecycle Enforcement**:
  - `ProductionApiFacade.runCandidateQa` executes `runSiteWideQa`, `runDesignDriftQa`, **and** `runTrustQa` automatically and passes `enforceTrustGates: true` to `ProductionStore.recordQaRun`.
  - `ProductionStore.recordQaRun` enforces `assertCompleteTrustQa`: if any required trust check is missing or non-`PASS` (`FAIL` or `REVIEW`), the candidate transitions to `qa_failed` and cannot reach `qa_passed`.

---

## N. Conversion Posture — Mode B (Blocks 16, 17, 21)

- Accepted Sutherland inputs do not include a live form endpoint, booking calendar, telephone, or email address.
- Accordingly, all pages operate in **Mode B**: no fake `<form>`, no `mailto:` or `tel:` links to invented addresses, and no dead CTA buttons. How an engagement begins (starting with a defined decision question in prose) is explained truthfully in the `page-cta` / conclusion sections.

---

## O. Per-Page Inspection Matrix (Blocks 22–26, 51)

| Field | Page 1 (`home`) | Page 2 (`services/buyer-side-advisory`) | Page 3 (`locations/chamonix`) | Page 4 (`advisory/investment-decision-framework`) | Page 5 (`research/alpine-decision-framework`) | Page 6 (`research/chamonix-supply-notes`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Route** | `/home` (plus `/` redirect stub) | `/services/buyer-side-advisory` | `/locations/chamonix` | `/advisory/investment-decision-framework` | `/research/alpine-decision-framework` | `/research/chamonix-supply-notes` |
| **Archetype (`PageArchetypeAuthority`)** | `homepage` | `service` | `location` | `investment_advisory` | `editorial` | `editorial` |
| **YMYL Class** | `YMYL_INFORMATIONAL` | `YMYL_INFORMATIONAL` | `YMYL_INFORMATIONAL` | `YMYL_DECISION_SUPPORT` | `YMYL_DECISION_SUPPORT` | `YMYL_DECISION_SUPPORT` |
| **Decision Role** | `NAVIGATIONAL_BRAND` | `COMMERCIAL_SERVICE_EVALUATION` | `GEOGRAPHIC_SERVICE_RELEVANCE` | `FINANCIAL_DECISION_SUPPORT` | `INFORMATIONAL_RESEARCH` | `INFORMATIONAL_RESEARCH` |
| **Accepted Title / H1** | `Independent Buyer-Side Advisory for French Alps Property Decisions` | `Buyer-Side Property Advisory: Scope and Engagement` | `Property Decision Support in Chamonix` | `Investment Decision Framework for Alpine Property` | `An Evidence-Led Decision Framework for Alpine Property` | `Supply-Side Notes for the Chamonix Decision Framework` |
| **Canonical URL** | `https://sutherlandam.com/home` | `https://sutherlandam.com/services/buyer-side-advisory` | `https://sutherlandam.com/locations/chamonix` | `https://sutherlandam.com/advisory/investment-decision-framework` | `https://sutherlandam.com/research/alpine-decision-framework` | `https://sutherlandam.com/research/chamonix-supply-notes` |
| **Visible Review Attribution** | `—` (`YMYL_INFORMATIONAL`) | `—` (`YMYL_INFORMATIONAL`) | `—` (`YMYL_INFORMATIONAL`) | `Alistair Sutherland` (`[data-review-authority]`) | `Alistair Sutherland` (`[data-review-authority]`) | `Alistair Sutherland` (`[data-review-authority]`) |
| **JSON-LD Types** | `WebPage`, `WebSite`, `Organization` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` |
| **Visual Slots Bound (`kind: "illustration"`)** | `hero-primary.home`, `supporting.home` | `hero-primary.services/buyer-side-advisory` | `hero-primary.locations/chamonix` | `hero-primary.advisory/investment-decision-framework` | `hero-primary.research/alpine-decision-framework` | `hero-primary.research/chamonix-supply-notes` |
| **Manifest Version** | `production-v3` | `production-v3` | `production-v3` | `production-v3` | `production-v3` | `production-v3` |
| **Site-Wide & Trust QA** | `PASS` | `PASS` | `PASS` | `PASS` | `PASS` | `PASS` |

---

## P. Project Design Authority & Design Implementation Contract (Blocks 27–30)

- **Schema Version**: `design-v2` (`DesignInputSnapshotV2` + `DesignCandidateDataV2` -> `AcceptedDesignArtifact`).
- **Design Provider**: `StitchDesignProvider` / `EvidenceStitchProvider` invoked **exactly once** (`providerCalls.length === 1`) for the project's archetype set (`homepage`, `service`, `location`, `investment_advisory`, `editorial`).
- **Governed Semantic Tokens**:
  - `primary`: `#1A2E35`
  - `secondary`: `#4A5A62`
  - `accent`: `#2F5D62`
  - `neutral`: `#F7F5F2`
  - `headingFont`: `Source Serif 4` (vendored WOFF2 under `/fonts/`)
  - `bodyFont`: `Public Sans` (vendored WOFF2 under `/fonts/`)
- **Design Implementation Contract (`design-implementation-v1`)**:
  - Deterministically compiled by `deriveDesignImplementationContract` under policy `production-policy-v3`.
  - Maps all 5 archetypes to registered Astro components (`page-hero`, `content-section`, `page-conclusion`, `page-cta`, `related-links`) with zero ad-hoc page-local CSS or unregistered components/variants.

---

## Q. Visual Asset Authority & Truth Discipline (Blocks 31–32 / P2-2, P2-4)

- **Visual Truth Classification & Asset Kind (P2-4)**: All required hero/supporting slots are explicitly classified as `illustrative` via `VisualService.confirmClassification` and resolved via `VisualService.resolveReuse` to approved operator-owned geometric SVG-rendered graphics (`abstract-hero.jpg` `1600x900`, `abstract-band.jpg` `1200x800`) registered with `kind: "illustration"` (never mislabelled as `"photo"`).
- **Exact Sixth-Page Slot & PPI Binding Verification (P2-2)**: Adding `/research/chamonix-supply-notes` produces a new `AcceptedVisualAssetSet` version (`v6 > v5`) with a distinct `setDigest`, preserving the initial 6 slots and adding `hero-primary.research/chamonix-supply-notes` (`kind: "illustration"`, verified `binarySha256` and `assetId`) bound into `sixthPpi.visualSlots` and `sixthManifest.composition.visualSlots`.

---

## R. Fifth-Page / Post-Design Reuse Proof (Block 33 / P2-1, P2-2)

Proven in `apps/factory/tests/persistence/run12-sutherland-multipage.test.ts` when adding `/research/chamonix-supply-notes` (`editorial` archetype) after the initial 5-page site is built:

| Metric | Before 6th Page | After 6th Page | Delta |
| :--- | :--- | :--- | :--- |
| **`AcceptedDesignArtifact` count / version** | `1` (version `1`) | `1` (version `1`, identical `id`) | **`0`** |
| **Stitch / `DesignProvider` calls** | `1` | `1` | **`0`** |
| **Manifest-derived component families (`manifests` vs `manifests2`)** | `5` (`content-section`, `page-conclusion`, `page-cta`, `page-hero`, `related-links`) | `5` (identical set extracted from `manifests2`) | **`0`** |
| **Design staleness (`staleness.stale`)** | `false` | `false` | **`0` (non-stale)** |
| **Built production manifests** | `5` | `6` | **`+1`** |

---

## S. Production Compilation, Real Build Identity & Persisted Evidence (Blocks 34–40 / P2-3, P2-5)

- **Real Build Identity (P2-3)**: Both the 5-page and 6-page `ProductionCandidate` builds and QA records bind the real repository Git `HEAD` SHA and real `pnpm-lock.yaml` SHA-256 loaded via `loadProductionBuildIdentity(repoRoot)` (no dummy constants).
- **Persisted Built Site & Screenshots Artifact (P2-5)**:
  - The built 6-page Sutherland site (`dist/`) and full-page Playwright screenshots (`screenshots/*.png` across desktop and mobile viewports) are persisted to `.factory/qa-evidence/run12-sutherland-site/` and uploaded as the `run12-sutherland-site` GitHub Actions artifact in `.github/workflows/pr-ci.yml`.

---

## T. Deterministic Site-Wide & Trust QA Results (Block 41 / P2-6)

Executed via `runSiteWideQa`, `runDesignDriftQa`, and `runTrustQa` (and enforced via `ProductionApiFacade.runCandidateQa` / `ProductionStore.recordQaRun`) on the built Sutherland candidate:
- **Site-Wide Technical & SEO Gates**:
  - `content.exact_match` / `content.no_duplicate_pages` -> `PASS`
  - `html.valid_structure` / `html.single_h1` / `html.heading_hierarchy` -> `PASS`
  - `seo.title_unique` / `seo.description_unique` / `seo.canonical` / `seo.sitemap` / `seo.robots` -> `PASS`
  - `structured_data.valid_json_ld` -> `PASS`
  - `links.internal_targets_exist` / `links.canonical_destination` -> `PASS`
  - `security.public_output` -> `PASS`
- **Design Drift Gates (`runDesignDriftQa`)**:
  - `design.contract_bound` / `design.tokens_governed` / `design.font_delivery_valid` / `design.composition_valid` / `design.no_raw_stitch_html` / `design.no_inline_style_escape` -> `PASS`
- **Mandatory YMYL Trust Governance Gates (`REQUIRED_TRUST_QA_GATES` / `runTrustQa`)**:
  - `trust.ymyl_classified` -> `PASS`
  - `trust.cannibalization` -> `PASS`
  - `trust.claim_lineage` -> `PASS`
  - `trust.calculation_reproducible` -> `PASS`
  - `trust.source_authority` -> `PASS`
  - `trust.original_value` -> `PASS`
  - `trust.ymyl_elements` -> `PASS`
  - `trust.review_authority` -> `PASS`
  - `trust.date_honesty` -> `PASS`
  - `trust.numerical_discipline` -> `PASS`

---

## U. Real-Browser Playwright E2E, Responsive, Accessibility & Lighthouse QA (Blocks 42–46)

- **Multi-Page E2E & Responsive QA (`sites/starter/tests/run12-multipage.e2e.spec.ts`)**:
  - Executed against the real built 6-page Sutherland `dist` via `astro preview` on both `desktop` (`1280x800`) and `mobile` (`390x844`) Chromium projects (`18 passed, 0 failed, 0 skipped` when invoked against the Sutherland build in `run12-sutherland-multipage.test.ts`).
  - Verifies HTTP 200, unique title, single `<h1>`, accepted Sutherland copy, visible `[data-review-authority="org-sutherland-private-office-research-committee"]` and `data-reviewed-digest` on all YMYL decision-support routes, zero fixture leakage, canonical URL, JSON-LD, primary navigation, editorial related-pages navigation, zero horizontal overflow (`scrollWidth <= clientWidth`), readable typography, monotonic vertical section stacking, and full-page screenshot capture.
- **Explicit Accounting of `35 passed, 31 skipped` in Default Workspace `pnpm qa`**:
  - During default workspace `pnpm qa`, Playwright runs 33 test definitions across 2 projects (`desktop` and `mobile` = 66 total invocations) against the default starter fixture build (`sites/starter/tests/fixtures`):
    1. `axe.production.spec.ts` (`8 skipped`): Defines a loop `for (const project of ["desktop", "mobile"])` with `test.skip(testInfo.project.name !== project)`. Because Playwright executes the file in both the `desktop` and `mobile` projects, the 4 `desktop`-tagged tests skip under the `mobile` runner (`4`) and the 4 `mobile`-tagged tests skip under the `desktop` runner (`4`), while all 8 `(route, viewport)` combinations execute and pass (`8 passed`).
    2. `run12-multipage.e2e.spec.ts` (`18 skipped` in default fixture build; `18 passed` in Sutherland multi-page build): Guards with `test.skip(!isSutherlandDist)` so the 9 Sutherland-specific tests (`6` route journeys + `3` cross-page navigation journeys × `2` viewports = `18`) skip during the default 4-route starter fixture build, and execute 100% (`18 passed, 0 skipped`) when `run12-sutherland-multipage.test.ts` runs Playwright against the built 6-page Sutherland site.
    3. `task-page.qa.spec.ts` (`2 skipped`): Legacy `SiteTask` parameterized spec (`1` test × `2` viewports) guarded by `test.skip(!configuredSpec)` unless `FACTORY_TASK_QA_SPEC` is set by a legacy single-page `SiteTask` worker.
    4. `visual.production.spec.ts` (`3 skipped`): Desktop structural and pixel regression baselines (`3` tests) execute and pass in the `desktop` project (`3 passed`) and skip in the `mobile` project (`3 skipped` via `test.skip(testInfo.project.name !== "desktop")`).
  - Total in default `pnpm qa`: `35 passed + (8 + 18 + 2 + 3 = 31) skipped = 66 invocations`. Against the built 6-page Sutherland artifact, `run12-multipage.e2e.spec.ts` executes all `18/18` journeys (`0 skipped`), `axe.production.spec.ts` executes all `12/12` content-page `(route, viewport)` checks (`0` critical/serious violations), and `keyboard.production.spec.ts` executes all `14/14` `(route, viewport)` keyboard traversal checks.
- **Automated Accessibility (`sites/starter/tests/axe.production.spec.ts` & `keyboard.production.spec.ts`)**:
  - `0` critical/serious Axe violations across all built pages on desktop and mobile.
  - Complete keyboard `Tab` focus traversal in DOM order across all interactive elements.
- **Visual Regression & Structural Oracle (`sites/starter/tests/visual.production.spec.ts`)**:
  - Passes both structural (`governed-service-fixture.structure.json`) and pixel (`governed-service-fixture.png`) regression oracles without modifying baselines.
- **Lighthouse CI (`pnpm --filter @factory/site-starter run test:lhci`)**:
  - Passes LAB performance (`>= 0.90`), accessibility (`>= 0.95`), SEO (`>= 0.95`), best-practices (`>= 0.95`), LCP (`<= 2500ms`), and CLS (`<= 0.1`).

---

## V. Staleness & Adversarial Proofs (Blocks 47–49)

### Block 47 — Staleness Proofs (`pre-run12-authority-chain.test.ts` & `run12-adversarial-design.test.ts`)
- Mutating `AcceptedPageContent` -> invalidates PPI / manifest digest.
- Mutating `PageArchetypeAuthority` (`v1 -> v2`) -> invalidates design snapshot & PPI.
- Mutating `AcceptedDesignArtifact` tokens or section patterns -> changes `implementationContractDigest`.
- Mutating `AcceptedVisualAssetSet` slot binary digest -> `deriveProductionInput` rejects closed.
- Mutating `rendererPolicyVersion` (`production-policy-v3 -> v4`) -> changes `implementationContractDigest`.
- Adding an ordinary page under an already-accepted archetype -> `designStaleness.stale === false`.

### Block 48 — Adversarial Design Governance (`run12-adversarial-design.test.ts`)
- Missing `AcceptedDesignArtifact` -> `production_authority_not_found`.
- Missing `PageArchetypeAuthority` -> `page_archetype_unclassified`.
- Missing required semantic token -> `design_implementation_unsupported`.
- Unapproved font family -> `design_font_delivery_unresolved`.
- Tampered manifest digest -> `assertManifest` throws `digest mismatch`.
- Unknown component or unknown variant -> `runDesignDriftQa` (`design.composition_valid`) returns `FAIL`.

### Block 49 — Adversarial YMYL Governance (`run12-adversarial-ymyl.test.ts`)
- Unsupported 18% performance claim -> `trust_claim_lineage_invalid` (`FAIL`).
- Forecast (`"The asset will appreciate 12%."` / `model_as_of_date`) disguised as `FACT` -> `trust_claim_lineage_invalid` (`FAIL`).
- Hidden assumption without limitation -> `trust_claim_lineage_invalid` (`FAIL`).
- Fabricated qualification (`CFA charterholder` without `evidenceRef`) -> `credentialPublishable === false`.
- Decorative citation (`entailment: "UNSUPPORTED"`, missing `entailment`, self-declared `TIER_A` without provenance, or non-entailing excerpt) -> `trust_claim_lineage_invalid` (`FAIL`), and `TIER_E` forum source on YMYL -> `sourceAuthorityVerdict` rejects.
- Uncovered material assertion in published page prose -> `runTrustQa` (`trust.claim_lineage`) returns `FAIL`.
- Missing `data-review-authority` in HTML or missing DB review on YMYL decision-support page -> `runTrustQa` (`trust.review_authority`) returns `FAIL` (never skipped).
- Declarative-only `OriginalValueRecord` (missing `lineageClaimId` or `verifiableAnchors` absent from HTML) -> `runTrustQa` (`trust.original_value`) returns `FAIL`.
- Candidate with unreviewed YMYL page or `REVIEW`/`FAIL` trust check -> `ProductionStore.recordQaRun(..., { enforceTrustGates: true })` transitions candidate to `qa_failed`.
- Fake freshness (date change without content digest change) & content mutation -> `reviewStaleness` binds strictly to `reviewedContentDigest`.
- Cannibalization duplicate pages -> `cannibalizationVerdict === "FAIL"`.
- Topic/expertise mismatch -> `checkTopicExpertiseMatch === "FAIL"`.
- Undisclosed material conflict of interest -> `checkConflictDisclosure === "FAIL"`.
- Prohibited guaranteed-return claim in Writer pipeline -> `writer.runQa` returns `FAIL`.

---

## W. Known Non-Blocking Limitations (Block 50)

1. **No Standalone `About` Archetype in Run 12**: `DESIGN_ARCHETYPE_KINDS` is fixed to `["homepage", "service", "location", "editorial", "investment_advisory"]`; per Block 2, no `about` archetype was invented and organization/creator/reviewer identity is presented on the 5 mandatory pages and 6th editorial page.
2. **Mode B Conversion Surface**: Because accepted Sutherland operator inputs do not yet include a live contact endpoint, phone number, or physical office address, pages use Mode B prose engagement instructions rather than interactive contact forms.
3. **Derivatives Disabled**: Static summary/audio derivatives remain in governed `state: "disabled"` for the Run 12 Sutherland proof.

---

## X. Run 12 P1 Audit Findings Closure Verification

All five P1 findings from the Independent Evidence QA Audit have been resolved and deterministically verified:

1. **R12-QA-01 — Chamonix PLU Operative Regulation Grounding**:
   - Acquired and archived official regulation PDF `74056_reglement_20260226.pdf` (approved 2026-02-26, enforceable 2026-05-09, Géoportail de l'Urbanisme `beaa82a7b5594b3913d5156928287d07`, SHA-256 `25425f385c72a88d3607a0314db9166efe9add139ca45314e124d3eb9bac707f`).
   - Implemented `CHAMONIX_PLU_APPLICABILITY_MATRIX` in `legal-evidence.ts` enforcing distinct thresholds: individual housing $\ge 200\text{ m}^2$ SP, collective programs $> 8$ units, tourist worker housing extensions up to 20% under Loi Montagne, principal-residence servitudes, and zone exclusions (UT, A, N). Universal hardcoded 300 m² and 200 m² assumptions eliminated.

2. **R12-QA-02 — Real Legal-Source Authenticity**:
   - `loadLegalEvidenceRegistry` enforces two-pass verification linking extracted provisions directly to verified raw captures in `TRUSTED_ACQUISITION_REGISTRY`.
   - `UNVERIFIED_SUMMARY` and unlinked extracts fail closed. Simulated signatures (e.g. `SIG-...-OFFICIAL`) are prohibited and rejected.

3. **R12-QA-03 — Real Editorial Review Boundary**:
   - `EditorialReviewService` (`editorial-review-boundary.ts`) requires authenticated principals and verified permissions.
   - `recordReviewLocked` in `trust/store.ts` rejects unauthenticated author-supplied review authority.
   - In `production/store.ts`, `TEST_ONLY_REVIEW_AUTHORITY` allows technical build and QA tests to run while strictly enforcing `publicationEligible: false`. Production publishing remains blocked until authentic human sign-off.

4. **R12-QA-04 — Trusted Research Acquisition Provenance**:
   - `TRUSTED_ACQUISITION_REGISTRY` enforces authenticated acquisition events for external research sources, checking canonical and final URLs, system timestamps, HTTP/archive metadata, raw digests, and authorized provider registrations. Missing provenance fails closed.

5. **R12-QA-05 — Elimination of Arbitrary Shell Execution**:
   - Dynamic shell execution (`execSync`) has been eliminated from `production/qa/trust.ts`.
   - Deterministic model reproductions run via registered pure TypeScript transformation functions (`transformation-registry.ts`) that compute outputs in memory and verify exact file digests and anchor text against disk artifacts.
