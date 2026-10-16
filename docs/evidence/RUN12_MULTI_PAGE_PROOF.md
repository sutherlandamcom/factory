# Factory Run 12 — High-Quality Multi-Page Sutherland Proof

## A. Executive Summary

Run 12 proves that Factory produces a real, coherent, trustworthy, useful, technically valid, multi-page Sutherland website (`Sutherland Private Office`) through the governed end-to-end Factory pipeline:

```text
Accepted Project Inputs
→ Search Intelligence (Run 2)
→ Competitor / Content-Gap Authority (Run 3)
→ Durable PageIntentAuthority & Anti-Cannibalization Gate
→ Writer Policy + Atomic Content Brief & PageArchetypeAuthority (PR #45)
→ Writer Prompt Snapshot + Governed Writer Proposal + Deterministic Content QA
→ AcceptedPageContent
→ Project DesignInputSnapshotV2 + Single AcceptedDesignArtifact (design-v2)
→ Deterministic DesignImplementationContract (design-implementation-v1)
→ VisualService Plan / Classification / Reuse / AcceptedVisualAssetSet
→ ProductionPageInput (PPI)
→ ProductionRenderCompiler (production-v3 manifests)
→ Astro 7 Static Build + Root Redirect Stub + Sitemap/Robots
→ Site-Wide Production QA + YMYL Trust Governance QA + Real-Browser Playwright E2E / Responsive / Axe / Keyboard / Lighthouse QA
```

All mandatory blocks (Blocks 0–63) are implemented, deterministically tested against PostgreSQL and the built Astro output, and verified against adversarial YMYL and design-governance failure cases.

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

## D. Page Strategy from Accepted Search & Content-Gap Authority (Block 3)

Derived from accepted Sutherland intake (`apps/factory/tests/fixtures/sutherland-intake.ts`) and accepted Search Intelligence + Content-Gap authority (`apps/factory/tests/fixtures/sutherland-seeds.ts`):

| Route | Page Identity | Archetype | Primary User Intent | Primary Query Cluster | Content-Gap Purpose | Site Role | Target Audience | Main User Task | Primary Conversion / Next Action | Internal Links Out | YMYL Classification |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/home` (and `/`) | `home` | `homepage` | Evaluate who should support a consequential French Alps property decision | Independent buyer-side advisory (French Alps) | Entity establishment + commercial-investigation orientation | Homepage: identity and orientation | International buyers evaluating a consequential French Alps property decision | Decide whether independent advisory fits the decision | Understand how an engagement begins (Mode B prose) | `—` (brand shell nav) | `YMYL_INFORMATIONAL` |
| `/services/buyer-side-advisory` | `services/buyer-side-advisory` | `service` | Evaluate the buyer-side advisory service scope and engagement model | Independent buyer-side advisory (French Alps) | Service differentiation: what the engagement does and does not do | Service evaluation | Buyers comparing independent advisory against listing intermediaries | Decide whether to engage the advisory service | Understand how an engagement begins (Mode B prose) | `research/alpine-decision-framework` | `YMYL_INFORMATIONAL` |
| `/locations/chamonix` | `locations/chamonix` | `location` | Understand advisory support for a Chamonix property decision | Location market understanding (Chamonix / Megève) | Geographic service relevance grounded in accepted location facts | Location relevance | Buyers considering Chamonix specifically | Decide how the advisory supports a Chamonix purchase | Understand how an engagement begins (Mode B prose) | `services/buyer-side-advisory` | `YMYL_INFORMATIONAL` |
| `/advisory/investment-decision-framework` | `advisory/investment-decision-framework` | `investment_advisory` | Use a framework to structure an alpine property investment decision | Decision methodology / evidence-led analysis | Financial decision support with explicit assumption/forecast separation | Decision support | Buyers weighing a financial decision on alpine property | Structure an investment decision with labelled uncertainty | Understand how an engagement begins (Mode B prose) | `research/alpine-decision-framework` | `YMYL_DECISION_SUPPORT` |
| `/research/alpine-decision-framework` | `research/alpine-decision-framework` | `editorial` | Study the evidence-led decision framework and its methodology | Decision methodology / evidence-led analysis | Original analytical value: reproducible framework + labelled calculation | Research credibility | Buyers and researchers evaluating alpine property decisions | Evaluate the framework's methodology and apply its structure | Understand how an engagement begins (Mode B prose) | `services/buyer-side-advisory`, `advisory/investment-decision-framework` | `YMYL_DECISION_SUPPORT` |
| `/research/chamonix-supply-notes` | `research/chamonix-supply-notes` | `editorial` | Read supply-side observations for Chamonix | Location market understanding (Chamonix / Megève) | Supply-side analytical texture for the Chamonix decision framework | Research depth (post-design reuse proof) | Buyers and researchers evaluating Chamonix supply constraints | Weigh seasonality and supply constraints with labelled observations | Understand how an engagement begins (Mode B prose) | `research/alpine-decision-framework`, `services/buyer-side-advisory` | `YMYL_DECISION_SUPPORT` |

---

## E. Cannibalization Matrix & Verdict (Block 4)

Enforced deterministically by `checkCannibalization(intents)` in `packages/contracts/src/trust-governance.ts` and `TrustGovernanceStore.cannibalizationVerdict(projectId)`:

- **Decision Roles**:
  - `home` -> `NAVIGATIONAL_BRAND`
  - `services/buyer-side-advisory` -> `COMMERCIAL_SERVICE_EVALUATION`
  - `locations/chamonix` -> `GEOGRAPHIC_SERVICE_RELEVANCE`
  - `advisory/investment-decision-framework` -> `FINANCIAL_DECISION_SUPPORT`
  - `research/alpine-decision-framework` -> `INFORMATIONAL_RESEARCH`
  - `research/chamonix-supply-notes` -> `INFORMATIONAL_RESEARCH` (distinct primary query cluster `Location market understanding (Chamonix / Megève)` and distinct primary intent `Read supply-side observations for Chamonix`)
- **Observed Cannibalization Verdict**: `PASS` (`0` pair findings across all 15 page pairs in the 6-page site; adversarial duplicate pair `services/a` + `services/b` deterministically returns `FAIL`).

---

## F. YMYL Classification Table (Block 5)

| Page Identity | YMYL Classification | Rationale from Actual Page Content |
| :--- | :--- | :--- |
| `home` | `YMYL_INFORMATIONAL` | Introduces the practice positioning, independence, and evidence-led method without specific financial calculations or recommendations. |
| `services/buyer-side-advisory` | `YMYL_INFORMATIONAL` | Explains advisory engagement scope, process, and explicit non-intermediation boundaries. |
| `locations/chamonix` | `YMYL_INFORMATIONAL` | Frames Chamonix decision factors and advisory coverage with qualitative expert interpretation labelled as such. |
| `advisory/investment-decision-framework` | `YMYL_DECISION_SUPPORT` | Structures financial/investment decision-making (requirement, evidence, assumptions, scenarios) and cross-references the labelled 7.2% gross-yield worked calculation. |
| `research/alpine-decision-framework` | `YMYL_DECISION_SUPPORT` | Publishes the analytical decision framework, methodology, source hierarchy, and the worked 7.2% gross-yield calculation under stated assumptions. |
| `research/chamonix-supply-notes` | `YMYL_DECISION_SUPPORT` | Publishes supply-side analytical observations for Chamonix property decisions under the decision framework. |

---

## G. Organization Trust Authority (Block 6)

- **Brand / Operating Name**: `Sutherland Private Office`
- **Business Activity**: Independent buyer-side property advisory for consequential property decisions in the French Alps (Chamonix and Megève).
- **Engagement Posture (Mode B)**: No unverified phone number, street address, company registration number, regulatory license, or client list is invented. Engagement initiation is explained truthfully in visible prose (Mode B), and organization identity (`Sutherland Private Office`, `https://sutherlandam.com/`) is visibly rendered in header/footer and projected truthfully into `Organization`, `WebSite`, and `WebPage` JSON-LD.

---

## H. Creator / Expert Authority (Block 7)

- **Responsible Creator**: `Sutherland Private Office` (organizational authorship bound to accepted first-party positioning evidence from the 2026-09-04 workflow handoff).
- **Topic ↔ Expertise Alignment**: Enforced via `checkTopicExpertiseMatch(requiredDomains, expertiseStatement)` in `packages/contracts/src/trust-governance.ts`. All YMYL decision-support pages bind to `Independent buyer-side alpine property advisory and evidence-led decision methodology`.

---

## I. Credential & Reputation Evidence Matrix (Block 8)

- **Credential Publication Rule (`credentialPublishable`)**: Any personal or regulatory credential requires a non-empty verifiable `evidenceRef`.
- **Sutherland Run 12 Status**: Zero personal credentials (e.g., CFA, RICS) or regulatory licenses are claimed in accepted inputs; therefore **zero** unverified credentials or awards are published on any page.
- **Conflict-of-Interest Disclosure (`checkConflictDisclosure`)**: Every page explicitly discloses that Sutherland Private Office acts on the buyer side, holds no listing inventory, and does not broker transactions for seller commissions.

---

## J. Review Authority & Staleness (Block 9)

- **Durable Table**: `review_authorities` (`apps/factory/drizzle/0034_trust_governance.sql`).
- **Digest Binding**: Each `ReviewAuthority` record binds `reviewerRef` (`org-sutherland-private-office`), `reviewerExpertise`, `reviewedAt` (`2026-09-04`), and `reviewedContentDigest` (exact SHA-256 of the accepted page content).
- **Staleness Proof**: `reviewStaleness(review, currentContentDigest)` and `TrustGovernanceStore.currentReview(...)` prove that date-only checks do not manufacture freshness and any change to `contentDigest` immediately marks the prior review `stale: true`.

---

## K. Claim Classification Matrix (Block 10)

Every material claim across all 6 production pages is classified in `claim_lineage_records` using the governed enum:
- `FIRST_PARTY_FACT`: Operator positioning and engagement boundary statements (`claim-home-independence`, `claim-home-evidence-led`, `claim-service-independence`, `claim-service-no-listing`, `claim-location-focus`).
- `CALCULATION`: Worked gross-yield example (`claim-yield-calc`, `claim-invest-yield-ref`: annual rent `26400 EUR/year` / purchase price `366000 EUR` = `7.2 %`, model `sutherland-gross-yield-v1`, calculated `2026-09-01`, with explicit limitation).
- `SCENARIO`: Scenario framing statement (`claim-invest-scenario`, with explicit limitation).
- `EXPERT_INTERPRETATION`: Qualitative market structure and supply-side observations (`claim-market-structure`, `claim-location-market-character`, `claim-supply-observations`, each with explicit limitation).

---

## L. Citation Entailment & Claim Lineage Table (Block 11)

- Enforced by `claimLineageVerdict(lineage)` in `packages/contracts/src/trust-governance.ts` and `TrustGovernanceStore.saveClaimLineage`:
  - Any claim with `entailment: "UNSUPPORTED"` fails closed (`trust_claim_lineage_invalid`).
  - Any claim classified as an observed fact (`FACT`, `FIRST_PARTY_FACT`, `SOURCE_DERIVED_FACT`) that relies on `freshnessBasis: "model_as_of_date"` or asserts future financial performance (`will appreciate/return/yield/earn`) fails closed (`trust_claim_lineage_invalid`).
  - Every `UNCERTAIN_CLAIM_TYPES` entry requires a non-empty `limitation`.
  - Every `CALCULATION` requires a complete `calculationRef` with `modelId`, non-empty `inputs`, `output`, and `calculatedAt`.

---

## M. Source Authority & Freshness Table (Blocks 12 & 13)

- **Source Tiers (`TIER_A`..`TIER_E`)**: All Sutherland production claims are backed by `TIER_A` first-party accepted positioning evidence (`2026-09-04`, `freshnessBasis: "historical_date"`) or `TIER_A` explicit worked-example model inputs (`2026-09-01`, `freshnessBasis: "model_as_of_date"` on `CALCULATION` / `SCENARIO` claims only).
- **Tier Gate (`sourceAuthorityVerdict`)**: `TIER_D` / `TIER_E` sources (such as forum posts) deterministically fail `YMYL_HIGH_IMPACT` (`FAIL`) and flag `YMYL_DECISION_SUPPORT` (`REVIEW`).

---

## N. Original Value & Helpful Content Gate (Blocks 14, 15, 19, 20)

- **Durable Table**: `original_value_records` (`TrustGovernanceStore.saveOriginalValue`).
- Each production page records its concrete original value (`original_decision_model`, `original_framework`, `first_party_observation`, `transparent_synthesis`) and passes `runTrustQa`:
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

## O. Conversion Posture — Mode B (Blocks 16, 17, 21)

- Accepted Sutherland inputs do not include a live form endpoint, booking calendar, telephone, or email address.
- Accordingly, all pages operate in **Mode B**: no fake `<form>`, no `mailto:` or `tel:` links to invented addresses, and no dead CTA buttons. How an engagement begins (starting with a defined decision question in prose) is explained truthfully in the `page-cta` / conclusion sections.

---

## P. Per-Page Inspection Matrix (Blocks 22–26, 51)

| Field | Page 1 (`home`) | Page 2 (`services/buyer-side-advisory`) | Page 3 (`locations/chamonix`) | Page 4 (`advisory/investment-decision-framework`) | Page 5 (`research/alpine-decision-framework`) | Page 6 (`research/chamonix-supply-notes`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Route** | `/home` (plus `/` redirect stub) | `/services/buyer-side-advisory` | `/locations/chamonix` | `/advisory/investment-decision-framework` | `/research/alpine-decision-framework` | `/research/chamonix-supply-notes` |
| **Archetype (`PageArchetypeAuthority`)** | `homepage` | `service` | `location` | `investment_advisory` | `editorial` | `editorial` |
| **YMYL Class** | `YMYL_INFORMATIONAL` | `YMYL_INFORMATIONAL` | `YMYL_INFORMATIONAL` | `YMYL_DECISION_SUPPORT` | `YMYL_DECISION_SUPPORT` | `YMYL_DECISION_SUPPORT` |
| **Decision Role** | `NAVIGATIONAL_BRAND` | `COMMERCIAL_SERVICE_EVALUATION` | `GEOGRAPHIC_SERVICE_RELEVANCE` | `FINANCIAL_DECISION_SUPPORT` | `INFORMATIONAL_RESEARCH` | `INFORMATIONAL_RESEARCH` |
| **Accepted Title / H1** | `Independent Buyer-Side Advisory for French Alps Property Decisions` | `Buyer-Side Property Advisory: Scope and Engagement` | `Property Decision Support in Chamonix` | `Investment Decision Framework for Alpine Property` | `An Evidence-Led Decision Framework for Alpine Property` | `Supply-Side Notes for the Chamonix Decision Framework` |
| **Canonical URL** | `https://sutherlandam.com/home` | `https://sutherlandam.com/services/buyer-side-advisory` | `https://sutherlandam.com/locations/chamonix` | `https://sutherlandam.com/advisory/investment-decision-framework` | `https://sutherlandam.com/research/alpine-decision-framework` | `https://sutherlandam.com/research/chamonix-supply-notes` |
| **JSON-LD Types** | `WebPage`, `WebSite`, `Organization` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` | `WebPage`, `WebSite`, `Organization`, `BreadcrumbList` |
| **Visual Slots Bound** | `hero-primary.home`, `supporting.home` | `hero-primary.services/buyer-side-advisory` | `hero-primary.locations/chamonix` | `hero-primary.advisory/investment-decision-framework` | `hero-primary.research/alpine-decision-framework` | `hero-primary.research/chamonix-supply-notes` |
| **Manifest Version** | `production-v3` | `production-v3` | `production-v3` | `production-v3` | `production-v3` | `production-v3` |
| **Site-Wide & Trust QA** | `PASS` | `PASS` | `PASS` | `PASS` | `PASS` | `PASS` |

---

## Q. Project Design Authority & Design Implementation Contract (Blocks 27–30)

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

## R. Visual Asset Authority & Truth Discipline (Blocks 31–32)

- **Visual Truth Classification**: All required hero/supporting slots are explicitly classified as `illustrative` via `VisualService.confirmClassification` and resolved via `VisualService.resolveReuse` to approved operator-owned abstract institutional imagery (`abstract-hero.jpg` `1600x900`, `abstract-band.jpg` `1200x800`).
- **Documentary Honesty**: Zero synthetic images impersonate real chalets, offices, staff, or clients.

---

## S. Fifth-Page / Post-Design Reuse Proof (Block 33)

Proven in `apps/factory/tests/persistence/run12-sutherland-multipage.test.ts` when adding `/research/chamonix-supply-notes` (`editorial` archetype) after the initial 5-page site is built:

| Metric | Before 6th Page | After 6th Page | Delta |
| :--- | :--- | :--- | :--- |
| **`AcceptedDesignArtifact` count / version** | `1` (version `1`) | `1` (version `1`, identical `id`) | **`0`** |
| **Stitch / `DesignProvider` calls** | `1` | `1` | **`0`** |
| **Registered component families** | `5` (`page-hero`, `content-section`, `page-conclusion`, `page-cta`, `related-links`) | `5` (identical set) | **`0`** |
| **Design staleness (`staleness.stale`)** | `false` | `false` | **`0` (non-stale)** |
| **Built production manifests** | `5` | `6` | **`+1`** |

---

## T. Production Compilation, Astro Build & SEO Architecture (Blocks 34–40)

- **Production Manifests**: All 6 pages compile to `production-v3` manifests with verified `manifestDigest`, `implementationContractDigest`, `semanticTokens`, `fontDelivery`, `composition`, and `derivatives: { state: "disabled" }`.
- **Root Delivery & Sitemap**:
  - Because the homepage slug is `home` (`/home`), `ProductionBuildService` emits a governed `noindex` meta-refresh redirect stub at `/index.html` -> `/home` so `/` resolves cleanly in browser navigation while `/home` remains the single canonical homepage URL in `sitemap.xml`.
  - `sitemap.xml` contains the exact canonical URLs for all indexable pages; `robots.txt` references `https://sutherlandam.com/sitemap.xml`.
  - Structured data (`WebPage`, `WebSite`, `Organization`, `BreadcrumbList`) matches visible page copy on every route.

---

## U. Deterministic Site-Wide & Trust QA Results (Block 41)

Executed via `runSiteWideQa` and `runTrustQa` on both the 5-page and 6-page built Sutherland candidates:
- `content.exact_match` / `content.no_duplicate_pages` -> `PASS`
- `html.valid_structure` / `html.single_h1` / `html.heading_hierarchy` -> `PASS`
- `seo.title_unique` / `seo.description_unique` / `seo.canonical` / `seo.sitemap` / `seo.robots` -> `PASS`
- `structured_data.valid_json_ld` -> `PASS`
- `links.internal_targets_exist` / `links.canonical_destination` -> `PASS`
- `security.public_output` -> `PASS`
- `trust.ymyl_classified` / `trust.cannibalization` / `trust.claim_lineage` / `trust.calculation_reproducible` / `trust.source_authority` / `trust.original_value` / `trust.ymyl_elements` / `trust.review_authority` / `trust.date_honesty` / `trust.numerical_discipline` -> `PASS`

---

## V. Real-Browser Playwright E2E, Responsive, Accessibility & Lighthouse QA (Blocks 42–46)

- **Multi-Page E2E & Responsive QA (`sites/starter/tests/run12-multipage.e2e.spec.ts`)**:
  - Executed against the real built 6-page Sutherland `dist` via `astro preview` on both `desktop` (`1280x800`) and `mobile` (`390x844`) Chromium projects.
  - Verifies HTTP 200, unique title, single `<h1>`, accepted Sutherland copy, zero fixture leakage, canonical URL, JSON-LD, primary navigation, editorial related-pages navigation, zero horizontal overflow (`scrollWidth <= clientWidth`), readable typography, and monotonic vertical section stacking.
- **Automated Accessibility (`sites/starter/tests/axe.production.spec.ts` & `keyboard.production.spec.ts`)**:
  - `0` critical/serious Axe violations across all built pages on desktop and mobile.
  - Complete keyboard `Tab` focus traversal in DOM order across all interactive elements.
- **Visual Regression & Structural Oracle (`sites/starter/tests/visual.production.spec.ts`)**:
  - Passes both structural (`governed-service-fixture.structure.json`) and pixel (`governed-service-fixture.png`) regression oracles without modifying baselines.
- **Lighthouse CI (`pnpm --filter @factory/site-starter run test:lhci`)**:
  - Passes LAB performance (`>= 0.90`), SEO (`>= 0.95`), best-practices (`>= 0.95`), LCP (`<= 2500ms`), and CLS (`<= 0.1`).

---

## W. Staleness & Adversarial Proofs (Blocks 47–49)

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
- Decorative citation (`entailment: "UNSUPPORTED"`) -> `trust_claim_lineage_invalid` (`FAIL`), and `TIER_E` forum source on high-impact YMYL -> `sourceAuthorityVerdict === "FAIL"`.
- Fake freshness (date change without content digest change) & content mutation -> `reviewStaleness` binds strictly to `reviewedContentDigest`.
- Fake reviewer (no governed `ReviewAuthority` event) -> `currentReview.review === null`.
- Cannibalization duplicate pages -> `cannibalizationVerdict === "FAIL"`.
- Topic/expertise mismatch -> `checkTopicExpertiseMatch === "FAIL"`.
- Undisclosed material conflict of interest -> `checkConflictDisclosure === "FAIL"`.
- Prohibited guaranteed-return claim in Writer pipeline -> `writer.runQa` returns `FAIL`.

---

## X. Known Non-Blocking Limitations (Block 50)

1. **No Standalone `About` Archetype in Run 12**: `DESIGN_ARCHETYPE_KINDS` is fixed to `["homepage", "service", "location", "editorial", "investment_advisory"]`; per Block 2, no `about` archetype was invented and organization/creator identity is presented on the 5 mandatory pages and 6th editorial page.
2. **Mode B Conversion Surface**: Because accepted Sutherland operator inputs do not yet include a live contact endpoint, phone number, or physical office address, pages use Mode B prose engagement instructions rather than interactive contact forms.
3. **Derivatives Disabled**: Static summary/audio derivatives remain in governed `state: "disabled"` for the Run 12 Sutherland proof.
