# RUN 12 — FACT AUDIT REGISTER (partial)

Status: **PARTIAL — only the INSEE housing facts below were independently inspected.**
Every other material claim in the Sutherland fixtures/pages is `UNVERIFIED` and must be
removed, narrowed or verified before any publication-eligible status (see "Not yet audited").

## Source snapshots (authentic external acquisition)

| source_id | origin | URL | retrieved | HTTP | bytes | sha256 | stored at |
|---|---|---|---|---|---|---|---|
| `insee-logement-2022-74056` | EXTERNAL_ACQUIRED | https://www.insee.fr/fr/statistiques/8581193?geo=COM-74056 | 2026-10-18 | 200 | 112384 | `9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150` | `docs/evidence/sources/insee-logement-2022/COM-74056.html` |
| `insee-logement-2022-74173` | EXTERNAL_ACQUIRED | https://www.insee.fr/fr/statistiques/8581193?geo=COM-74173 | 2026-10-18 | 200 | 111983 | `929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4` | `docs/evidence/sources/insee-logement-2022/COM-74173.html` |

Document: INSEE, "Logement en 2022", RP2022 exploitation principale, geography as of 01/01/2025.
Extraction: `apps/factory/src/trust/insee-evidence.ts` (parses only the digest-pinned stored bytes).

## Verified INSEE facts (reporting year 2022)

| geo | table | row | column | raw | parsed | unit |
|---|---|---|---|---|---|---|
| 74056 | LOG T1 | Ensemble | 2022 | 14 538 | 14538 | dwellings |
| 74056 | LOG T1 | Résidences principales | 2022 | 4 312 | 4312 | dwellings |
| 74056 | LOG T1 | Rés. secondaires et logements occasionnels | 2022 | 10 073 | 10073 | dwellings |
| 74056 | LOG T1 | Logements vacants | 2022 | 154 | 154 | dwellings |
| 74056 | LOG T1bis | Résidences principales | 2022 | 29,7 | 29.7 | % of dwellings |
| 74056 | LOG T1bis | Rés. secondaires et occasionnels | 2022 | 69,3 | 69.3 | % of dwellings |
| 74056 | LOG T1bis | Logements vacants | 2022 | 1,1 | 1.1 | % of dwellings |
| 74056 | LOG T2 | Appartements | 2022:share | 72,6 | 72.6 | % of dwellings |
| 74173 | LOG T1 | Ensemble | 2022 | 9 354 | 9354 | dwellings |
| 74173 | LOG T1bis | Résidences principales | 2022 | 16,1 | 16.1 | % of dwellings |
| 74173 | LOG T1bis | Rés. secondaires et occasionnels | 2022 | 82,9 | 82.9 | % of dwellings |
| 74173 | LOG T1bis | Logements vacants | 2022 | 1,0 | 1.0 | % of dwellings |
| 74173 | LOG T2 | Appartements | 2022:share | 81,1 | 81.1 | % of dwellings |

All values agree with the reference values supplied in the Run 12 prompt. Status: `VERIFIED`.

## Discrepancies in existing repository fixtures (status `REJECTED` → `CORRECTED` required)

| claim (fixture location) | published value | source value | status |
|---|---|---|---|
| Chamonix total dwellings 2022 | 13,864 | 14,538 | REJECTED — correction **NOT YET APPLIED** to fixtures |
| Chamonix secondary residences 2022 | 69.2% | 69.3% | REJECTED — NOT YET APPLIED |
| Chamonix primary residences 2022 | 26.8% | 29.7% | REJECTED — NOT YET APPLIED |
| Chamonix vacant 2022 | 4.0% | 1.1% | REJECTED — NOT YET APPLIED |
| Megève total dwellings 2022 | 11,291 | 9,354 | REJECTED — NOT YET APPLIED |
| Megève secondary residences 2022 | 83.1% | 82.9% | REJECTED — NOT YET APPLIED |
| Megève primary residences 2022 | 13.4% | 16.1% | REJECTED — NOT YET APPLIED |
| Megève apartments 2022 | 78.8% | 81.1% | REJECTED — NOT YET APPLIED |
| Chamonix main residences built 1946–1990 | 58.2% | 2 475 / 4 231 = **58.5%** (24,2 + 34,3 displayed = 58.5) | REJECTED — NOT YET APPLIED |
| Chamonix "only 6.0% built since 2006" | 6.0% | LOG T5 "De 2006 à 2019" = 13.5% of main residences built **before 2020** | REJECTED — NOT YET APPLIED |
| `contract test`: "72.6% secondary residences" | 72.6% | 72.6% is the **apartment** share; secondary = 69.3% | REJECTED (test fixture) |
| Source URL `…/statistiques/2011101?geo=COM-…` | publication 2011101 | authoritative publication for these tables is 8581193 | REJECTED — NOT YET APPLIED |

Affected files (grep inventory): `apps/factory/tests/fixtures/sutherland-intake.ts`, `sutherland-seeds.ts`,
`tests/persistence/run12-sutherland-multipage.test.ts`, `run12-adversarial-ymyl.test.ts` (known-bad values
there are legitimate negative-test inputs), `trust-governance*.test.ts`, `docs/evidence/RUN12_MULTI_PAGE_PROOF.md`.

LOG T5 note: the newest category is "De 2006 à 2019" in a table limited to main residences "construites avant 2020";
it must not be rendered as "2006 or later".

## Not yet audited (all `UNVERIFIED`)

Loi Hoguet / Carte T; purchase procedure and 10-day withdrawal; DPE/audit obligations and rental-restriction
dates; Chamonix PLU; tourist-rental registration; DVF; IFI threshold; Géorisques/PPRN; Cour des comptes; the
"90 inhabitants per year" and "1 May 2025" figures; the 26,400 / 366,000 gross-yield example (arithmetic
7.2131% is reproducible but the calculation record is not yet independently recomputed by QA); the
buyer-side / `mandat de recherche` wording (must be reviewed against the advisory-only operating limitation).
