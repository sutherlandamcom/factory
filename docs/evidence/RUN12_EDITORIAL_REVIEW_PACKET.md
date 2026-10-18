# Factory Run 12 — Editorial Review & YMYL Sign-Off Packet (`RUN12_EDITORIAL_REVIEW_PACKET.md`)

> **STATUS**: `AUTOMATED_VALIDATION: PASSED` | `HUMAN_EDITORIAL_REVIEW: PENDING`  
> **GOVERNANCE RULE**: Automated QA verifies factual lineage, statistical snapshots, statutory logic, and numerical reproducibility. In accordance with the Factory Constitution and Run 12 rules, real-world YMYL publication requires independent human editorial review. This packet compiles all authoritative evidence for human review.

---

## 1. Review Packet Overview & Scope

- **Brand / Entity**: `Sutherland Private Office`
- **Candidate SHA**: `feat/run12-multipage-proof`
- **Scope**: 6 Production Pages (5 core pages + 1 post-design reuse research note):
  1. `/home` (`homepage` / `YMYL_INFORMATIONAL`)
  2. `/services/buyer-side-advisory` (`service` / `YMYL_INFORMATIONAL`)
  3. `/locations/chamonix` (`location` / `YMYL_INFORMATIONAL`)
  4. `/advisory/investment-decision-framework` (`investment_advisory` / `YMYL_DECISION_SUPPORT`)
  5. `/research/alpine-decision-framework` (`editorial` / `YMYL_DECISION_SUPPORT`)
  6. `/research/chamonix-supply-notes` (`editorial` / `YMYL_DECISION_SUPPORT`)

---

## 2. Organization, Advisory Boundary & Regulatory Standing

### Entity Identity & Operating Boundary
- **Operating Model**: Independent, buyer-side residential property advisory specializing in consequential acquisitions in the French Alps (Chamonix-Mont-Blanc and Megève).
- **Statutory Demarcation (Loi Hoguet — Law No. 70-9 of 2 January 1970)**:
  - `Sutherland Private Office` is an independent advisory and research practice.
  - It does **not** act as a real estate broker or sales agent.
  - It holds **no listing inventory**, accepts no developer or seller commissions, and does not execute intermediated search mandates (`mandat de recherche`) requiring a real estate broker card (`carte professionnelle T`).
  - All property purchases are completed through independent, licensed French notaires (`Notaires de France`).
- **Conversion Posture (Mode B)**:
  - In strict compliance with privacy and truth discipline, no fabricated email, phone number, physical address, or client case studies are presented. Engagement initiation is explained clearly in prose (Mode B).

---

## 3. Page-by-Page Audit & Review Dossiers

### Dossier 1: Homepage (`/home` & `/`)
- **Route**: `/home` (governed 301/308 redirect from `/`)
- **Archetype**: `homepage`
- **YMYL Category**: `YMYL_INFORMATIONAL`
- **Primary Objective**: Clarify Sutherland's independent advisory positioning, separate buyer advice from broker sales, and set baseline alpine housing context.
- **Authoritative Fact Ledger**:
  - `Loi Hoguet Law No. 70-9 of 2 January 1970`: Demarcation between regulated intermediation requiring `carte T` and independent buyer-side research.
  - `INSEE RP2022 (8581193)`:
    - Chamonix (`74056`): `14,538` total dwellings (`69.3%` secondary, `29.7%` primary, `1.1%` vacant).
    - Megève (`74173`): `9,354` total dwellings (`82.9%` secondary, `16.1%` primary, `1.0%` vacant).
  - `DGFiP DVF` & `Notaires de France`: `5-year` transaction records, `10-day` statutory cooling-off period, and DPE energy audit requirements.
- **Reviewer Checklist**:
  - [ ] Positioning clearly distinguishes advisory from sales agency.
  - [ ] INSEE dwelling totals and secondary residence percentages match official records.
  - [ ] No fabricated customer testimonials or unverified telephone/email contacts.

---

### Dossier 2: Service Advisory (`/services/buyer-side-advisory`)
- **Route**: `/services/buyer-side-advisory`
- **Archetype**: `service`
- **YMYL Category**: `YMYL_INFORMATIONAL`
- **Primary Objective**: Detail the four-phase advisory engagement model, conflict disclosures, and French conveyancing protections.
- **Authoritative Fact Ledger**:
  - `Notaires de France / CCH Art. L271-1`: `10-day` buyer cooling-off period (`délai de rétractation`) following bilateral contract execution (`compromis de vente`).
  - `Loi Climat et Résilience / DPE`: Energy audit requirements for classes `F` and `G` (extended to `E` in `2025`), alongside rental prohibition milestones (`G+` in `2023`, `G` in `2025`, `F` in `2028`, `E` in `2034`).
  - `Chamonix PLU & Géorisques PPRN`: Mandatory local screening of municipal permanent-housing servitudes and natural hazard zones before commitment.
- **Reviewer Checklist**:
  - [ ] Clear disclosure that Sutherland does not receive transaction commissions from sellers or listing brokers.
  - [ ] Legal cooling-off period and DPE timetable accurately reflect French law.
  - [ ] Scope clearly articulates deliverables (acquisition memorandum, risk ledger, negotiation brief).

---

### Dossier 3: Location Market Due Diligence (`/locations/chamonix`)
- **Route**: `/locations/chamonix`
- **Archetype**: `location`
- **YMYL Category**: `YMYL_INFORMATIONAL`
- **Primary Objective**: Provide verifiable supply, vintage, planning, and environmental constraints for Chamonix-Mont-Blanc compared to Megève.
- **Authoritative Fact Ledger**:
  - `INSEE RP2022 LOG T2 & LOG T5`:
    - Chamonix housing typology: `72.6%` apartments (`10,558`), `26.6%` houses (`3,874`).
    - Chamonix vintage (main residences built before 2020, denominator `4,231`): `58.5%` built `1946–1990` (`2,475`), `13.5%` built `2006–2019` (`572`).
    - Megève housing typology: `81.1%` apartments (`7,585`), `18.6%` houses (`1,740`).
  - `Ville de Chamonix-Mont-Blanc PLU`: Permanent-residence servitudes (`servitudes de résidence principale`) and `25%` social-mix quotas across constructible zones for collective developments over 300 m² floor area.
  - `Chamonix Short-Term Rental By-Law (Effective 1 May 2025)`: Mandatory registration numbers, primary residences capped at `90` days per year, and natural-person owners restricted to `1` secondary-residence rental authorization.
  - `Géorisques PPRN & Cour des comptes (Feb 2024)`: Risk mapping for avalanches, torrential floods, and rockfalls alongside official climate-adaptation findings for ski resorts.
- **Reviewer Checklist**:
  - [ ] Construction period percentages correctly specify the denominator (main residences built before 2020).
  - [ ] Municipal rental rules accurately cite the `1 May 2025` effective date and `90-day` cap.
  - [ ] Social-housing quota specifies the 300 m² floor-area threshold.
  - [ ] Natural hazard disclosures emphasize parcel-level cadastre verification.

---

### Dossier 4: Investment Decision Framework (`/advisory/investment-decision-framework`)
- **Route**: `/advisory/investment-decision-framework`
- **Archetype**: `investment_advisory`
- **YMYL Category**: `YMYL_DECISION_SUPPORT`
- **Primary Objective**: Structure financial, tax, and capex decisions for alpine residential assets with transparent assumptions.
- **Authoritative Fact Ledger**:
  - `DGFiP DVF & CGI Articles 964–965 (IFI)`: Impôt sur la Fortune Immobilière net taxable wealth threshold of `1,300,000 EUR`, with taxation calculated progressively starting from `800,000 EUR`.
  - `Verified Calculation Model (Illustrative Gross Yield on Equity)`:
    $$\text{Annual Rent} = 26{,}400\text{ EUR}$$
    $$\text{Purchase Price} = 366{,}000\text{ EUR}$$
    $$\text{Gross Yield on Invested Equity} = \frac{26{,}400}{366{,}000} \times 100 = 7.2131\dots\% \longrightarrow 7.2\%$$
  - `Important Qualification Footnote`:
    - The 7.2% metric is strictly an illustrative **gross rental yield**.
    - It does **not** deduct co-ownership charges, management fees, maintenance reserves, *taxe foncière*, or income tax.
    - In the underlying verified model artifact (`docs/evidence/models/alpine-yield-model-v1.json`), net annual return after operating costs, fees, and taxes is simulated at **4.3%**.
  - `Explicit Scenario Limitations`:
    - Model assumes `35` weeks seasonal occupancy, `40%` operating costs, and `3.2%` fixed borrowing rate.
    - Explicitly labelled as a scenario illustration (`ASSUMPTION`), not a guaranteed return or factual forecast.
- **Reviewer Checklist**:
  - [ ] Formula and inputs are mathematically reproducible.
  - [ ] 7.2% is clearly qualified as gross rental yield on equity rather than a net return.
  - [ ] Returns are framed as illustrative scenario outputs, with clear disclaimers that actual yields vary with debt terms, snow conditions, and maintenance costs.
  - [ ] IFI wealth tax limits correctly distinguish the entry threshold (`1,300,000 EUR`) from the assessment starting bracket (`800,000 EUR`).

---

### Dossier 5: Analytical Decision Methodology (`/research/alpine-decision-framework`)
- **Route**: `/research/alpine-decision-framework`
- **Archetype**: `editorial`
- **YMYL Category**: `YMYL_DECISION_SUPPORT`
- **Primary Objective**: Publish the four-tier institutional due-diligence methodology and data-sourcing standards.
- **Authoritative Fact Ledger**:
  - Full cross-validation of INSEE RP2022, DGFiP DVF, Notaires de France DPE audit timelines, Chamonix PLU zoning, and Géorisques PPRN hazard mapping.
  - Step-by-step audit trail for purchase price validation, technical capex reserve calculation, and regulatory risk scoring.
  - Explicit documentation of the reproducible `7.2%` illustrative gross equity yield calculation (with net return simulation at `4.3%`).
- **Reviewer Checklist**:
  - [ ] Methodology is described with academic and professional rigor.
  - [ ] Primary sources are cited with complete, verifiable metadata.
  - [ ] 7.2% gross yield qualification is clearly footnoted against net simulation.
  - [ ] Visible attribution to `org-sutherland-private-office-research-committee` (`[data-review-authority]`) is present in the rendered HTML.

---

### Dossier 6: Chamonix Supply Notes (`/research/chamonix-supply-notes`)
- **Route**: `/research/chamonix-supply-notes`
- **Archetype**: `editorial`
- **YMYL Category**: `YMYL_DECISION_SUPPORT`
- **Primary Objective**: Deep-dive supply-side analytical note on physical stock constraints, aging chalets, and municipal tourism regulation in the Chamonix valley.
- **Authoritative Fact Ledger**:
  - Physical supply constraints: `14,538` total dwellings; `10,073` secondary residences (`69.3%`); only `154` vacant dwellings (`1.1%`).
  - Stock vintage: `58.5%` of pre-2020 primary residences built between 1946 and 1990; only `13.5%` built between 2006 and 2019, reflecting strict valley topographical limits.
  - Regulatory squeeze: `25%` social-mix quotas in constructible zones under the Chamonix PLU for collective operations exceeding 300 m² floor area; municipal short-term rental quotas effective `1 May 2025` limiting primary rentals to `90` days and restricting owners to `1` secondary authorization.
- **Reviewer Checklist**:
  - [ ] Analysis accurately synthesizes INSEE data with local planning servitudes.
  - [ ] Social-housing quota specifies the 300 m² floor-area threshold.
  - [ ] Clear distinction between general supply observations and individual investment advice.
  - [ ] Independent reviewer attribution and reviewed content digest correctly embedded.

---

## 4. Human Reviewer Sign-Off Protocol & Review Authority Discipline

### Distinguishing Test Authority from Genuine Review
- `TEST_ONLY_REVIEW_AUTHORITY`: Used strictly in automated integration tests to exercise workflow mechanics. **Cannot** authorize production publication (`qaRunPublicationEligible(result) === false`).
- `VERIFIED_HUMAN_REVIEW_AUTHORITY`: Requires an authentic human action captured as an `AuthenticatedApprovalEvent`, including:
  - `reviewEventId`: Unique identifier for the review action.
  - `authenticatedActorId`: Verified ID of the human reviewer (e.g., `actor-sutherland-board-01`).
  - `actorRole`: Authorized role (e.g., `Managing Director & Head of Editorial Governance`).
  - `authorizationScope`: Must cover the page's YMYL classification.
  - `reviewAction`: `APPROVED`.
  - `reviewedContentDigest`, `reviewedClaimSetDigest`, `reviewedSourceEvidenceDigest`: Exact SHA-256 digests matching the candidate state.
  - `eventTimestamp`: Timestamp of human action.
  - `auditEventReference`: Verifiable reference to review minutes or ledger.

### Current Candidate Status
- **Candidate Status**: `EDITORIAL_REVIEW_PENDING` (`publicationEligible: false`).
- **Terminal Status**: `TECHNICAL REMEDIATION COMPLETE — EDITORIAL REVIEW PENDING — INDEPENDENT QA PENDING — DO NOT MERGE`.

### Human Reviewer Acceptance Steps
1. **Verify Evidence Artifacts**:
   - Inspect raw HTML snapshots in `docs/evidence/sources/insee-logement-2022/`.
   - Inspect executable models: `docs/evidence/models/chamonix-supply-dataset-v1.json`, `docs/evidence/models/alpine-yield-model-v1.json`, `docs/evidence/models/investment-matrix-v1.json`.
   - Execute reproduction scripts: `reproduce-chamonix-supply.ts`, `reproduce-alpine-yield.ts`, `reproduce-investment-matrix.ts`.
   - Verify that all claims in `docs/evidence/RUN12_FACT_AUDIT.md` match source documents.
2. **Review Rendered Experience**:
   - Inspect full-page desktop and mobile screenshots in `.factory/qa-evidence/run12-sutherland-site/screenshots/`.
   - Confirm that visible review authority attribution (`[data-review-authority]`) appears on all three YMYL decision-support pages.
3. **Execute Formal Acceptance**:
   - Human reviewer records authorized action and signs off with a structured `AuthenticatedApprovalEvent`.
