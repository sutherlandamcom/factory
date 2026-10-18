# Factory Run 12 — Complete Claim & Source Integrity Audit (`RUN12_FACT_AUDIT.md`)

## 1. Executive Summary

This document records the complete claim-by-claim factual, statistical, statutory, regulatory, and calculation audit across all six production pages of the `Sutherland Private Office` website in Run 12 (`feat/run12-multipage-proof`).

### Principal Remediation Summary

1. **INSEE RP2022 Housing Statistics Corrected & Digest-Pinned (Block 3 & Block 6)**:
   - Acquired authentic primary HTML snapshots from INSEE (`Logement en 2022`, publication `8581193`, released `2025-07-01`):
     - **Chamonix-Mont-Blanc (`COM-74056`)**: `docs/evidence/sources/insee-logement-2022/COM-74056.html` (`sha256: 9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150`)
     - **Megève (`COM-74173`)**: `docs/evidence/sources/insee-logement-2022/COM-74173.html` (`sha256: 929215205222683cff2563d2063692b8c87b33e5fffbb72940f3624150...` -> `929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4`)
   - All previously inaccurate figures (`13,864` total Chamonix dwellings, `11,291` total Megève dwellings, `27.3%` / `69.2%` / `3.5%` Chamonix split, `78.8%` Megève secondary share, `58.2%` 1946–1990 share, and `6.0%` 2006–2019 share) were **REMOVED** from all positive production paths (`sutherland-intake.ts`, `sutherland-seeds.ts`, `run12-sutherland-multipage.test.ts`, and `ClaimLineage` records) and **CORRECTED** to exact official INSEE 2022 values.
   - Known-bad figures remain **solely** inside adversarial negative mutation tests (`M01`–`M08` in `run12-source-integrity.test.ts` and `run12-source-integrity-qa.test.ts`).

2. **French Legal & Regulatory Claims Verified & Corrected (Block 4)**:
   - **Loi Hoguet (`Law No. 70-9 of 2 January 1970`)**: Verified statutory boundary. Corrected all competitive/seed descriptions so `Sutherland Private Office` is strictly framed as non-intermediated buyer-side research and decision support—never executing a regulated `mandat de recherche`, holding `Carte T`, or brokering property for seller commissions.
    - **Chamonix PLU**: Replaced the unverified `"90 inhabitants per year"` claim with the verified Chamonix PLU rule: permanent-housing servitudes (`servitudes de résidence principale`) and `25%` social-mix quotas across constructible residential zones for collective developments exceeding the 300 m² floor-area threshold (`surface de plancher`).
    - **Chamonix Short-Term Rental Regulation (`1 May 2025`)**: Verified municipal rule requiring registration numbers, capping primary-residence rentals at `90` days per year, and limiting natural-person owners to `1` secondary-residence rental authorization.
    - **Notaires de France / Code de la construction et de l'habitation (Article L271-1 & Loi Climat et Résilience)**: Verified mandatory `10-day` cooling-off period (`délai de rétractation`) after signing the `compromis de vente` and DPE rental prohibition schedule (`G+` from `2023`, `G` from `2025`, `F` from `2028`, `E` from `2034`, plus mandatory energy audits for classes `F` and `G`, extended to `E` in `2025`).
    - **DGFiP (DVF & CGI Articles 964–965 IFI)**: Verified DVF `5-year` rolling open-data deed history and IFI net real-estate trigger (`1,300,000 EUR`) with progressive assessment starting from `800,000 EUR`.
    - **Géorisques PPRN & Cour des comptes (`February 2024`)**: Verified parcel-level avalanche, torrential flood, and slope-movement zoning under PPRN and Cour des comptes thematic climate-adaptation findings for French ski resorts.

---

## 2. Official INSEE RP2022 Evidence Ledger (`8581193`)

| Geography | Commune Code | Table | Metric | Official 2022 Count | Official 2022 Share | Previous Defect Value | Remediation Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T1 / LOG T2` | `ensemble` (Total dwellings) | `14 538` (`14,538`) | `100,0%` | `13,864` | **CORRECTED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T2` | `residences_principales` (Primary residences) | `4 312` (`4,312`) | `29,7%` (`29.7%`) | `27.3%` (`3,785`) | **CORRECTED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T2` | `residences_secondaires_et_logements_occasionnels` (Secondary residences) | `10 073` (`10,073`) | `69,3%` (`69.3%`) | `69.2%` (`9,594`) | **CORRECTED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T2` | `logements_vacants` (Vacant dwellings) | `154` | `1,1%` (`1.1%`) | `3.5%` (`485`) | **CORRECTED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T2` | `appartements` (Apartments) | `10 558` (`10,558`) | `72,6%` (`72.6%`) | — | **VERIFIED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T2` | `maisons` (Individual houses) | `3 874` (`3,874`) | `26,6%` (`26.6%`) | — | **VERIFIED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T5` | Main residences built before 2020 (`ensemble_construites_avant_2020`, denominator `4,231`): `1946–1990` (`722 + 950 + 803`) | `2 475` (`2,475` of `4,231`) | `58,5%` (`58.5%` of main residences built before 2020) | `58.2%` (misattributed to total dwellings) | **CORRECTED** |
| **Chamonix-Mont-Blanc** | `74056` | `LOG T5` | Main residences built before 2020 (`ensemble_construites_avant_2020`, denominator `4,231`): `2006–2019` (`de_2006_a_2019`) | `572` (`572` of `4,231`) | `13,5%` (`13.5%` of main residences built before 2020) | `6.0%` (`2006–2019` false share) | **CORRECTED** |
| **Megève** | `74173` | `LOG T1 / LOG T2` | `ensemble` (Total dwellings) | `9 354` (`9,354`) | `100,0%` | `11,291` | **CORRECTED** |
| **Megève** | `74173` | `LOG T2` | `residences_principales` (Primary residences) | `1 506` (`1,506`) | `16,1%` (`16.1%`) | `18.4%` | **CORRECTED** |
| **Megève** | `74173` | `LOG T2` | `residences_secondaires_et_logements_occasionnels` (Secondary residences) | `7 759` (`7,759`) | `82,9%` (`82.9%`) | `78.8%` | **CORRECTED** |
| **Megève** | `74173` | `LOG T2` | `logements_vacants` (Vacant dwellings) | `89` | `1,0%` (`1.0%`) | `2.8%` | **CORRECTED** |
| **Megève** | `74173` | `LOG T2` | `appartements` (Apartments) | `7 585` (`7,585`) | `81,1%` (`81.1%`) | — | **VERIFIED** |
| **Megève** | `74173` | `LOG T2` | `maisons` (Individual houses) | `1 740` (`1,740`) | `18,6%` (`18.6%`) | — | **VERIFIED** |

---

## 3. Complete Claim-by-Claim Audit Across All 6 Production Pages

### Page 1: `home` (`/home`) — `YMYL_INFORMATIONAL`

| Claim ID | Claim Type | Published Claim Text | Primary Authority & URL | Evidence Origin | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `claim-home-hoguet` | `FACT` (Statutory) | `Under French Loi Hoguet Law No. 70-9 of 2 January 1970, regulated intermediation requires a carte professionnelle T and written mandat.` | Légifrance — Law No. 70-9 of 2 January 1970 (`https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` + `claimLineageVerdict` | **VERIFIED** |
| `claim-home-insee` | `FACT` (Statistical) | `INSEE 2022 records 14,538 dwellings in Chamonix-Mont-Blanc (69.3% secondary residences, 29.7% primary residences, 1.1% vacant) and 9,354 dwellings in Megève (82.9% secondary residences, 16.1% primary residences, 1.0% vacant).` | INSEE RP2022 `8581193` (`COM-74056` & `COM-74173`, `https://www.insee.fr/fr/statistiques/8581193?sommaire=8581488&geo=COM-74056`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyInseeClaim` (8 exact `LOG T2` bindings across `74056` and `74173` verified against SHA-256 HTML snapshots) | **CORRECTED** |
| `claim-home-dvf-notaires` | `FACT` (Statutory / Regulatory) | `Buyers evaluate five-year DGFiP DVF notarized deeds, Notaires de France 10-day cooling-off rules, and DPE class G/F/E energy audit thresholds.` | DGFiP DVF (`https://app.dvf.etalab.gouv.fr/`) & Notaires de France (`https://www.notaires.fr/fr/immobilier-fiscalite/diagnostic-immobilier/le-diagnostic-de-performance-energetique-dpe`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` + `claimLineageVerdict` | **VERIFIED** |

### Page 2: `services/buyer-side-advisory` (`/services/buyer-side-advisory`) — `YMYL_INFORMATIONAL`

| Claim ID | Claim Type | Published Claim Text | Primary Authority & URL | Evidence Origin | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `claim-service-notaires-dpe` | `FACT` (Statutory / Regulatory) | `Notaires de France purchase protocol includes a mandatory 10-day buyer cooling-off period after the compromis de vente and requires energy audits for DPE class F and G properties, extended to class E in 2025, alongside rental prohibitions for G+ in 2023, G in 2025, F in 2028, and E in 2034.` | Notaires de France (`https://www.notaires.fr/fr/immobilier-fiscalite/diagnostic-immobilier/le-diagnostic-de-performance-energetique-dpe`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` (enforces exact DPE schedule `2023`/`2025`/`2028`/`2034` and `10-day` cooling-off) | **VERIFIED** |
| `claim-service-hoguet` | `FACT` (Statutory) | `Sutherland Private Office holds no property inventory and does not broker transactions for seller commissions under Loi Hoguet Law No. 70-9 of 2 January 1970.` | Légifrance (`https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000512228`) & Sutherland First-Party Intake | `VERIFIED_ARCHIVED_EXTERNAL` + `ACCEPTED_FIRST_PARTY` | `verifyStatutoryAndRegulatoryClaim` (blocks any claim implying brokerage without Carte T) | **VERIFIED** |
| `claim-service-plu-pprn` | `FACT` (Regulatory) | `Each mandate screens five-year DGFiP DVF deeds, Chamonix PLU permanent-housing servitudes, and Géorisques PPRN hazard zones before a buyer commits to a property.` | DGFiP DVF (`https://app.dvf.etalab.gouv.fr/`), Ville de Chamonix PLU (`https://www.chamonix.fr/`), Géorisques (`https://www.georisques.gouv.fr/`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` + `claimLineageVerdict` | **CORRECTED** |

### Page 3: `locations/chamonix` (`/locations/chamonix`) — `YMYL_INFORMATIONAL`

| Claim ID | Claim Type | Published Claim Text | Primary Authority & URL | Evidence Origin | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `claim-location-chamonix-insee` | `FACT` (Statistical) | `INSEE 2022 records 14,538 dwellings in Chamonix-Mont-Blanc (29.7% primary residences, 69.3% secondary residences, 1.1% vacant; 72.6% apartments and 26.6% houses) compared with 9,354 dwellings in Megève (82.9% secondary residences and 16.1% primary residences), while 58.5% of Chamonix main residences built before 2020 date from 1946–1990 and 13.5% from 2006–2019.` | INSEE RP2022 `8581193` (`COM-74056` & `COM-74173`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyInseeClaim` (9 exact bindings across `LOG T2` and `LOG T5`, including denominator check for `4,231` main residences built before 2020) | **CORRECTED** |
| `claim-location-chamonix-plu` | `FACT` (Regulatory) | `Ville de Chamonix-Mont-Blanc PLU applies permanent-housing servitudes and 25% social-mix quotas across constructible residential zones for collective developments over 300 m² floor area, and from 1 May 2025 caps primary-residence short-term rentals at 90 days per year and limits natural-person owners to one secondary-residence rental authorization.` | Ville de Chamonix-Mont-Blanc (`https://www.chamonix.fr/`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` (verifies `25%` social-mix for `> 300 m²` floor area & `90 days` / `1 May 2025`) | **CORRECTED** |
| `claim-location-chamonix-pprn` | `FACT` (Regulatory) | `Géorisques PPRN maps parcel-level avalanche, torrential flood, and slope-movement zones in Chamonix alongside Cour des comptes February 2024 climate-adaptation findings, and DGFiP DVF records five-year notarized deeds.` | Géorisques (`https://www.georisques.gouv.fr/`), Cour des comptes (`https://www.ccomptes.fr/fr/publications/les-stations-de-ski-face-au-changement-climatique`), DGFiP DVF (`https://app.dvf.etalab.gouv.fr/`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` + `claimLineageVerdict` | **VERIFIED** |

### Page 4: `advisory/investment-decision-framework` (`/advisory/investment-decision-framework`) — `YMYL_DECISION_SUPPORT`

| Claim ID | Claim Type | Published Claim Text | Primary Authority & URL | Evidence Origin | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `claim-advisory-dvf-ifi` | `FACT` (Statutory) | `DGFiP DVF provides five-year notarized transaction records and CGI Articles 964–965 set the IFI net real-estate threshold at 1,300,000 EUR with assessment starting at 800,000 EUR.` | DGFiP DVF (`https://app.dvf.etalab.gouv.fr/`) & Légifrance CGI Arts. 964–965 (`https://www.legifrance.gouv.fr/codes/section_lc/LEGITEXT000006069577/LEGISCTA000036385038/`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` (verifies `1,300,000 EUR` trigger and `800,000 EUR` assessment start) | **VERIFIED** |
| `claim-advisory-dpe-assumption` | `ASSUMPTION` | `Scenario models treat DPE class G/F/E energy retrofit budgets and Chamonix 90-day or single-secondary-residence rental limits as explicit assumptions subject to contractor quotes and municipal rules.` | Notaires de France DPE (`https://www.notaires.fr/...`) & Ville de Chamonix (`https://www.chamonix.fr/`) | `VERIFIED_ARCHIVED_EXTERNAL` | `claimLineageVerdict` (requires non-empty `limitationStatement` and `modelAsOfDate: 2026-09-01`) | **VERIFIED** |
| `claim-advisory-yield-calc` | `CALCULATION` | `Annual rent of 26400 EUR over a purchase price of 366000 EUR gives an illustrative gross yield of 7.2% under stated assumptions.*` | Sutherland First-Party Financial Methodology + DGFiP CGI Arts. 964–965 | `ACCEPTED_FIRST_PARTY` + `VERIFIED_ARCHIVED_EXTERNAL` | `verifyCalculationProvenance` (recomputes `(26400 / 366000) * 100 = 7.2131...% -> 7.2%` at `1_dp`, unit `%`) | **VERIFIED** |

> *Footnote: 7.2% represents an illustrative gross rental yield on equity/purchase base (26,400 EUR / 366,000 EUR = 7.2131%). Operating charges, co-ownership fees, taxe foncière, management fees, and income tax are not deducted. Under the reproduction model (`docs/evidence/models/alpine-yield-model-v1.json`), net annual return after operating costs and taxes is simulated at 4.3%.

### Page 5: `research/alpine-decision-framework` (`/research/alpine-decision-framework`) — `YMYL_DECISION_SUPPORT`

| Claim ID | Claim Type | Published Claim Text | Primary Authority & URL | Evidence Origin | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `claim-research-insee-dvf` | `FACT` (Statistical & Statutory) | `The framework pairs INSEE 2022 housing stock data (14,538 Chamonix dwellings and 9,354 Megève dwellings) with five-year DGFiP DVF notarized deeds and CGI Articles 964–965 IFI thresholds (1,300,000 EUR trigger, 800,000 EUR assessment start).` | INSEE RP2022 `8581193` (`COM-74056` & `COM-74173`), DGFiP DVF, Légifrance CGI Arts. 964–965 | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyInseeClaim` (`14,538` & `9,354` bindings) + `verifyStatutoryAndRegulatoryClaim` | **CORRECTED** |
| `claim-research-dpe-pprn` | `FACT` (Statutory / Regulatory) | `Step two audits Notaires de France 10-day cooling-off rules, DPE class G/F/E schedules (2023, 2025, 2028, 2034), Chamonix PLU servitudes and May 2025 rental caps, Géorisques PPRN hazard zones, and Cour des comptes February 2024 climate-adaptation findings.` | Notaires de France, Ville de Chamonix, Géorisques, Cour des comptes | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` + `claimLineageVerdict` | **VERIFIED** |
| `claim-research-yield` | `CALCULATION` | `Step four computes labelled calculations: annual rent of 26400 EUR over 366000 EUR purchase price gives an illustrative 7.2% gross yield.*` | Sutherland First-Party Financial Methodology + Notaires de France DPE | `ACCEPTED_FIRST_PARTY` + `VERIFIED_ARCHIVED_EXTERNAL` | `verifyCalculationProvenance` (recomputes `(26400 / 366000) * 100 = 7.2%` at `1_dp`, unit `%`) | **VERIFIED** |

> *Footnote: 7.2% is explicitly classified as gross rental yield on invested equity. Net return after operating expenses, co-ownership charges, property taxes, and income taxes is separately modeled at 4.3% in `docs/evidence/artifacts/alpine-yield-model-v1.json`.

### Page 6: `research/chamonix-supply-notes` (`/research/chamonix-supply-notes`) — `YMYL_DECISION_SUPPORT`

| Claim ID | Claim Type | Published Claim Text | Primary Authority & URL | Evidence Origin | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `claim-supply-insee` | `FACT` (Statistical) | `INSEE 2022 records 14,538 total dwellings in Chamonix-Mont-Blanc (69.3% secondary residences, 29.7% primary residences, 1.1% vacant; 72.6% apartments and 26.6% houses), with 58.5% of main residences built before 2020 constructed between 1946 and 1990 and 13.5% between 2006 and 2019.` | INSEE RP2022 `8581193` (`COM-74056`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyInseeClaim` (8 exact bindings across `LOG T2` and `LOG T5` verified against `COM-74056.html`) | **CORRECTED** |
| `claim-supply-plu-meubles` | `FACT` (Regulatory) | `Ville de Chamonix-Mont-Blanc PLU enforces permanent-housing servitudes and 25% social-mix quotas across constructible residential zones for collective developments over 300 m² floor area, and from 1 May 2025 limits primary-residence short-term rentals to 90 days per year and caps natural-person owners at one secondary-residence rental authorization.` | Ville de Chamonix-Mont-Blanc (`https://www.chamonix.fr/`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` | **CORRECTED** |
| `claim-supply-pprn` | `FACT` (Regulatory) | `Géorisques PPRN hazard zoning and Cour des comptes February 2024 ski-station findings constrain net buildable land in the Chamonix valley, requiring parcel-by-parcel DVF and DPE verification.` | Géorisques (`https://www.georisques.gouv.fr/`) & Cour des comptes (`https://www.ccomptes.fr/...`) | `VERIFIED_ARCHIVED_EXTERNAL` | `verifyStatutoryAndRegulatoryClaim` + `claimLineageVerdict` | **VERIFIED** |
