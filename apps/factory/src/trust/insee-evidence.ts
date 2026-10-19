import { createHash } from "node:crypto";

/**
 * RUN 12 REMEDIATION — Independent INSEE source evidence (Blocks 3 & 6).
 *
 * Trust separation: the claim author never supplies the evidence. This module
 * parses ONLY stored, digest-pinned bytes of the official INSEE
 * "Logement en 2022" publication (https://www.insee.fr/fr/statistiques/8581193)
 * and produces ExtractedSourceFact records keyed by
 * (geography, reporting year, table, row, column). Claims are then compared
 * against those facts on value, unit, year, geography and metric.
 *
 * It never trusts a `supportingExcerpt`, a self-declared tier, or a source
 * label.
 */

export interface SourceEvidenceSnapshot {
  sourceId: string;
  sourceOrigin: "EXTERNAL_ACQUIRED" | "VERIFIED_ARCHIVED_EXTERNAL";
  originalUrl: string;
  publisher: "INSEE";
  documentTitle: string;
  geoCode: string;
  reportingYear: number;
  rawContentDigest: string;
  storedEvidenceLocation: string;
  contentType: "text/html";
}

export type InseeUnit = "dwellings" | "percent_of_dwellings" | "percent_of_main_residences" | "main_residences";

export interface ExtractedSourceFact {
  sourceSnapshotId: string;
  geoCode: string;
  reportingYear: number;
  tableId: "LOG T1" | "LOG T1bis" | "LOG T2" | "LOG T5";
  rowKey: string;
  columnKey: string;
  rawValue: string;
  parsedValue: number;
  unit: InseeUnit;
  extractionMethod: "insee-html-table-v1";
}

export const INSEE_PUBLICATION_ID = "8581193";

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function inseeSourceUrl(geoCode: string): string {
  return `https://www.insee.fr/fr/statistiques/${INSEE_PUBLICATION_ID}?geo=COM-${geoCode.replace(/^COM-/, "")}`;
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;|\u00a0|\u202f/g, " ")
    .replace(/&minus;|&ndash;|–|−/g, "-")
    .replace(/&eacute;/g, "é")
    .replace(/&egrave;/g, "è")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFrNumber(raw: string): number {
  const cleaned = raw.replace(/\s/g, "").replace(",", ".").replace(/^-/, "-");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`insee_unparseable_value: "${raw}"`);
  return n;
}

function tables(html: string): string[][][] {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((t) =>
    [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
      [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => decode(c[1]!)),
    ),
  );
}

export function geoTitleCode(html: string): string | null {
  const m = html.match(/Commune de [^<(]{2,60}\((\d{5})\)/);
  return m ? m[1]! : null;
}

/** Parse the stored INSEE bytes into independently extracted facts. */
export function extractInseeFacts(snapshot: SourceEvidenceSnapshot, bytes: Buffer): ExtractedSourceFact[] {
  if (sha256Hex(bytes) !== snapshot.rawContentDigest) {
    throw new Error("insee_snapshot_digest_mismatch: stored bytes do not match the accepted digest");
  }
  const html = bytes.toString("utf8");
  const titleCode = geoTitleCode(html);
  if (titleCode !== snapshot.geoCode) {
    throw new Error(`insee_snapshot_geography_mismatch: document is ${titleCode ?? "unknown"}, snapshot declares ${snapshot.geoCode}`);
  }
  const t = tables(html);
  const facts: ExtractedSourceFact[] = [];
  const push = (
    tableId: ExtractedSourceFact["tableId"],
    rowKey: string,
    columnKey: string,
    raw: string,
    unit: InseeUnit,
    year = snapshot.reportingYear,
  ) =>
    facts.push({
      sourceSnapshotId: snapshot.sourceId,
      geoCode: snapshot.geoCode,
      reportingYear: year,
      tableId,
      rowKey,
      columnKey,
      rawValue: raw,
      parsedValue: parseFrNumber(raw),
      unit,
      extractionMethod: "insee-html-table-v1",
    });

  // LOG T1: counts by category and year (table 0).
  const t1 = t[0]!;
  const t1Years = t1[0]!.slice(1).map((y) => Number(y.replace(/\(\*\)/, "")));
  for (const row of t1.slice(1)) {
    t1Years.forEach((year, i) => push("LOG T1", row[0]!, String(year), row[i + 1]!, "dwellings", year));
  }
  // LOG T1bis: shares of dwellings by category (table 1).
  const t1b = t[1]!;
  const t1bYears = t1b[0]!.slice(1).map(Number);
  for (const row of t1b.slice(1)) {
    t1bYears.forEach((year, i) => push("LOG T1bis", row[0]!, String(year), row[i + 1]!, "percent_of_dwellings", year));
  }
  // LOG T2: types of dwellings (table 2): Year, %, Year, %, ...
  const t2 = t[2]!;
  const hdr = t2[0]!;
  for (const row of t2.slice(1)) {
    for (let c = 1; c < hdr.length; c += 2) {
      const year = Number(hdr[c]);
      push("LOG T2", row[0]!, `${year}:count`, row[c]!, "dwellings", year);
      push("LOG T2", row[0]!, `${year}:share`, row[c + 1]!, "percent_of_dwellings", year);
    }
  }
  // LOG T5: main residences by completion period (table 7), 2022 only, "built before 2020".
  const t5 = t[7]!;
  if (t5[0]![0] !== "Période d'achèvement") throw new Error("insee_table_layout_changed: LOG T5 not found at expected position");
  for (const row of t5.slice(1)) {
    push("LOG T5", row[0]!, "count", row[1]!, "main_residences", 2022);
    push("LOG T5", row[0]!, "share", row[2]!, "percent_of_main_residences", 2022);
  }
  return facts;
}

export type ClaimFailureCode =
  | "claim_value_mismatch"
  | "claim_year_mismatch"
  | "claim_geography_mismatch"
  | "claim_unit_mismatch"
  | "claim_metric_unknown"
  | "source_snapshot_unverified";

export interface NumericClaim {
  geoCode: string;
  reportingYear: number;
  tableId: ExtractedSourceFact["tableId"];
  rowKey: string;
  columnKey: string;
  value: number;
  unit: InseeUnit;
}

export type ClaimVerification =
  | { status: "VERIFIED"; fact: ExtractedSourceFact }
  | { status: "FAIL"; code: ClaimFailureCode; detail: string };

/**
 * Compare a claim to independently extracted facts. A claim passes only when
 * geography, year, metric, unit AND value all match an extracted fact.
 */
export function verifyNumericClaim(claim: NumericClaim, facts: ReadonlyArray<ExtractedSourceFact>): ClaimVerification {
  const forGeo = facts.filter((f) => f.geoCode === claim.geoCode);
  if (forGeo.length === 0) {
    return { status: "FAIL", code: "claim_geography_mismatch", detail: `No verified evidence for geography ${claim.geoCode}.` };
  }
  const forMetric = forGeo.filter((f) => f.tableId === claim.tableId && f.rowKey === claim.rowKey);
  if (forMetric.length === 0) {
    return { status: "FAIL", code: "claim_metric_unknown", detail: `No extracted fact for ${claim.tableId} / ${claim.rowKey}.` };
  }
  const forYear = forMetric.filter((f) => f.reportingYear === claim.reportingYear);
  if (forYear.length === 0) {
    return { status: "FAIL", code: "claim_year_mismatch", detail: `Evidence does not cover reporting year ${claim.reportingYear} for ${claim.rowKey}.` };
  }
  const forColumn = forYear.filter((f) => f.columnKey === claim.columnKey);
  if (forColumn.length === 0) {
    return { status: "FAIL", code: "claim_metric_unknown", detail: `No extracted fact for column ${claim.columnKey}.` };
  }
  const fact = forColumn[0]!;
  if (fact.unit !== claim.unit) {
    return { status: "FAIL", code: "claim_unit_mismatch", detail: `Claim unit ${claim.unit} differs from source unit ${fact.unit}.` };
  }
  if (Math.abs(fact.parsedValue - claim.value) > 1e-9) {
    return {
      status: "FAIL",
      code: "claim_value_mismatch",
      detail: `Claimed ${claim.value} but ${claim.tableId}/${claim.rowKey}/${claim.columnKey} for ${claim.geoCode} ${claim.reportingYear} is ${fact.rawValue}.`,
    };
  }
  return { status: "VERIFIED", fact };
}

/** Derived share from raw counts with an explicit one-decimal half-up rounding rule. */
export function derivedSharePercent(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 1000 + Number.EPSILON) / 10;
}

// ---------------------------------------------------------------------------
// Production integration: registry + claim-level independent verification.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaimLineage, EvidenceBinding, SourceRef } from "@factory/contracts";

export const INSEE_EVIDENCE_DIR = ["docs", "evidence", "sources", "insee-logement-2022"] as const;

export const COMMUNE_NAMES: Record<string, string> = {
  "74056": "Chamonix-Mont-Blanc",
  "74173": "Megève",
};

export interface InseeEvidenceRegistry {
  /** Facts extracted from digest-verified stored bytes only. */
  facts: ExtractedSourceFact[];
  /** Snapshots whose stored bytes failed digest/geography verification. */
  rejected: Array<{ geoCode: string; reason: string }>;
  snapshots: SourceEvidenceSnapshot[];
}

interface ManifestEntry {
  geoCode: string;
  reportingYear: number;
  originalUrl: string;
  file: string;
  sha256: string;
}

/** Load the stored snapshots listed in the evidence manifest; verify every digest. */
export function loadInseeEvidenceRegistry(repoRoot: string): InseeEvidenceRegistry {
  const dir = path.join(repoRoot, ...INSEE_EVIDENCE_DIR);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      facts: [],
      rejected: [{ geoCode: "*", reason: `insee_manifest_not_found: ${manifestPath}` }],
      snapshots: [],
    };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { snapshots: ManifestEntry[] };
  const registry: InseeEvidenceRegistry = { facts: [], rejected: [], snapshots: [] };
  for (const entry of manifest.snapshots) {
    const snapshot: SourceEvidenceSnapshot = {
      sourceId: `insee-logement-${entry.reportingYear}-${entry.geoCode}`,
      sourceOrigin: "EXTERNAL_ACQUIRED",
      originalUrl: entry.originalUrl,
      publisher: "INSEE",
      documentTitle: `Logement en ${entry.reportingYear}`,
      geoCode: entry.geoCode,
      reportingYear: entry.reportingYear,
      rawContentDigest: entry.sha256,
      storedEvidenceLocation: path.posix.join(...INSEE_EVIDENCE_DIR, entry.file),
      contentType: "text/html",
    };
    try {
      if (entry.originalUrl !== inseeSourceUrl(entry.geoCode)) throw new Error("insee_manifest_url_mismatch");
      const filePath = path.join(dir, entry.file);
      if (!existsSync(filePath)) {
        throw new Error(`insee_snapshot_file_not_found: ${entry.file}`);
      }
      registry.facts.push(...extractInseeFacts(snapshot, readFileSync(filePath)));
      registry.snapshots.push(snapshot);
    } catch (error) {
      registry.rejected.push({ geoCode: entry.geoCode, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return registry;
}

export function isInseeSourceRef(ref: SourceRef): boolean {
  return /\binsee\b/i.test(ref.ref) || (ref.sourceUrl ? /insee\.fr/i.test(ref.sourceUrl) : false);
}

export interface IndependentVerification {
  ok: boolean;
  problems: string[];
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function bindingValueForms(binding: EvidenceBinding): string[] {
  if (binding.unit === "dwellings" || binding.unit === "main_residences") return [formatCount(binding.value), String(binding.value)];
  return [binding.value.toFixed(1)];
}

/** Numbers in claim text that must be backed by a binding (excludes years and commune codes). */
function materialNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b\d[\d,]*(?:\.\d+)?%?/g)) {
    const raw = m[0];
    const bare = raw.replace(/[%,]/g, "");
    if (/^(19|20)\d{2}$/.test(bare) && !raw.includes("%")) continue; // years
    if (/^\d{5}$/.test(bare) && !raw.includes(",") && !raw.includes("%")) continue; // geo codes
    if (/^\d{1,2}$/.test(bare) && !raw.includes("%") && !raw.includes(".")) continue; // small ordinals/day counts
    out.push(raw.replace(/%$/, ""));
  }
  return out;
}

/**
 * Independently verify the INSEE-sourced portion of a claim. The claim's own
 * supportingExcerpt, entailment label and tier are IGNORED: only the declared
 * evidence bindings, checked against digest-verified stored source bytes, and
 * the claim text itself are compared.
 */
export function verifyInseeClaim(claim: ClaimLineage, registry: InseeEvidenceRegistry): IndependentVerification {
  const problems: string[] = [];
  const inseeRefs = claim.sourceRefs.filter(isInseeSourceRef);
  if (inseeRefs.length === 0) return { ok: true, problems };
  const text = claim.claimText;
  const allBindings: EvidenceBinding[] = [];

  for (const ref of inseeRefs) {
    const bindings = ref.evidenceBindings ?? [];
    if (bindings.length === 0) {
      problems.push(`${claim.claimId}: source_evidence_unbound — INSEE source has no independently verifiable evidence binding (self-declared SUPPORTED/TIER_A is not proof).`);
      continue;
    }
    for (const b of bindings) {
      allBindings.push(b);
      if (registry.rejected.some((r) => r.geoCode === b.geoCode)) {
        problems.push(`${claim.claimId}: source_snapshot_unverified — stored evidence for ${b.geoCode} failed verification (${registry.rejected.find((r) => r.geoCode === b.geoCode)!.reason}).`);
        continue;
      }
      if (ref.sourceUrl !== inseeSourceUrl(b.geoCode)) {
        problems.push(`${claim.claimId}: source_url_mismatch — sourceUrl "${ref.sourceUrl ?? ""}" is not the INSEE publication for commune ${b.geoCode} (${inseeSourceUrl(b.geoCode)}).`);
      }
      if (b.kind === "table_fact") {
        const r = verifyNumericClaim(
          { geoCode: b.geoCode, reportingYear: b.reportingYear, tableId: b.tableId, rowKey: b.rowKey, columnKey: b.columnKey, value: b.value, unit: b.unit },
          registry.facts,
        );
        if (r.status === "FAIL") problems.push(`${claim.claimId}: ${r.code} — ${r.detail}`);
      } else {
        const count = (row: string) =>
          registry.facts.find((f) => f.geoCode === b.geoCode && f.reportingYear === b.reportingYear && f.tableId === b.tableId && f.rowKey === row && f.columnKey === "count");
        const den = count(b.denominatorRow);
        const nums = b.numeratorRows.map(count);
        if (!den || nums.some((n) => !n)) {
          problems.push(`${claim.claimId}: claim_metric_unknown — derived share rows not found in verified evidence.`);
        } else {
          if (b.tableId === "LOG T5" && b.denominatorRow !== "Résidences principales construites avant 2020") {
            problems.push(
              `${claim.claimId}: claim_denominator_mismatch — LOG T5 construction vintage share must use denominator "Résidences principales construites avant 2020", not "${b.denominatorRow}".`,
            );
          }
          const derived = derivedSharePercent(nums.reduce((a, n) => a + n!.parsedValue, 0), den.parsedValue);
          if (Math.abs(derived - b.value) > 1e-9) {
            problems.push(`${claim.claimId}: claim_value_mismatch — derived share is ${derived}% (from ${nums.map((n) => n!.parsedValue).join("+")} / ${den.parsedValue}), claimed ${b.value}%.`);
          }
        }
        if (b.unit === "percent_of_main_residences" && /\bof\s+(?:total|all)\s+dwellings\b/i.test(text)) {
          problems.push(
            `${claim.claimId}: claim_denominator_mismatch — claim text attributes a main-residence share (${b.value}%) to total dwellings.`,
          );
        }
      }
      // Check category pairing when a percentage value appears in text (M06).
      if (b.kind === "table_fact" && b.unit === "percent_of_dwellings") {
        const pctToken = `${b.value.toFixed(1)}%`;
        const idx = text.indexOf(pctToken);
        if (idx >= 0) {
          const tail = text.slice(idx + pctToken.length, idx + pctToken.length + 38);
          const expectedCategory: Record<string, RegExp> = {
            "Résidences principales": /\b(?:primary|main)\s+residences?\b/i,
            "Résidences secondaires et logements occasionnels": /\bsecondary(?:\s+residences?)?\b/i,
            "Logements vacants": /\bvacant\b/i,
            Appartements: /\bapartments?\b/i,
            Maisons: /\bhouses?\b/i,
          };
          const anyCategory = /\b(?:primary\s+residences?|main\s+residences?|secondary(?:\s+residences?)?|vacant(?:\s+dwellings?)?|apartments?|houses?)\b/i;
          const exp = expectedCategory[b.rowKey];
          if (exp && anyCategory.test(tail) && !exp.test(tail)) {
            problems.push(
              `${claim.claimId}: claim_category_mismatch — ${pctToken} in ${b.tableId} (${b.geoCode}) is "${b.rowKey}", which contradicts "${tail.trim()}".`,
            );
          }
        }
      }
      // Geography identity in text.
      const name = COMMUNE_NAMES[b.geoCode];
      const mentionsGeo = (name && text.includes(name)) || text.includes(b.geoCode);
      if (!mentionsGeo) problems.push(`${claim.claimId}: claim_geography_mismatch — claim text does not name commune ${b.geoCode}${name ? ` (${name})` : ""}.`);
      for (const [code, other] of Object.entries(COMMUNE_NAMES)) {
        if (code !== b.geoCode && (text.includes(other) || text.includes(code)) && !allBindingsCover(claim, code)) {
          problems.push(`${claim.claimId}: claim_geography_mismatch — claim text names ${other} but no binding covers commune ${code}.`);
        }
      }
    }
  }

  // At least one bound value must appear in the text (relevance), the bound year must match any
  // stated year, and EVERY material number in an INSEE-attributed sentence must be backed by a
  // verified binding (the safety property: a wrong number can never ride on a correct citation).
  const bound = new Set<string>();
  let anyAppears = allBindings.length === 0;
  for (const b of allBindings) {
    const forms = bindingValueForms(b);
    forms.forEach((f) => bound.add(f));
    if (forms.some((f) => text.includes(f))) anyAppears = true;
    const yearMatch = text.match(/\b(?:in|for|INSEE)\s+(20\d{2})\b/);
    if (yearMatch && Number(yearMatch[1]) !== b.reportingYear) {
      problems.push(`${claim.claimId}: claim_year_mismatch — claim text states ${yearMatch[1]} but evidence reporting year is ${b.reportingYear}.`);
    }
  }
  if (!anyAppears) problems.push(`${claim.claimId}: claim_text_binding_mismatch — no verified bound value appears in the claim text.`);
  const inseeSentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => /\bINSEE\b/.test(sentence));
  for (const sentence of inseeSentences) {
    for (const n of materialNumbers(sentence)) {
      if (!bound.has(n)) problems.push(`${claim.claimId}: claim_number_unbound — "${n}" in an INSEE-attributed sentence is not backed by any verified evidence binding.`);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

function allBindingsCover(claim: ClaimLineage, geoCode: string): boolean {
  return claim.sourceRefs.some((r) => (r.evidenceBindings ?? []).some((b) => b.geoCode === geoCode));
}

/**
 * Independent verification of French legal, regulatory, and provenance rules
 * (Block 4, Block 5, Block 6: M13, M14, M19, M24).
 */
export function verifyStatutoryAndRegulatoryClaim(claim: ClaimLineage): IndependentVerification {
  const problems: string[] = [];
  const text = claim.claimText;

  // M24: Unverified claim left in production copy
  if (
    /\bUNVERIFIED\b/i.test(claim.limitation) ||
    /\bUNVERIFIED\b/i.test(text) ||
    claim.sourceRefs.some((r) => /\bUNVERIFIED\b/i.test(r.ref) || /\bUNVERIFIED\b/i.test(r.supportingExcerpt ?? ""))
  ) {
    problems.push(
      `${claim.claimId}: unverified_claim_in_production_copy — Claim or source is marked UNVERIFIED and cannot pass production YMYL QA.`,
    );
  }

  // M19: Synthetic fixture research claimed as production evidence
  if (
    claim.sourceRefs.some(
      (r) =>
        r.evidenceOrigin === "SYNTHETIC_FIXTURE" ||
        /\b(?:synthetic[_\s-]*fixture|fixture[_\s-]*provider|mock[_\s-]*serp|synthetic[_\s-]*serp)\b/i.test(r.ref) ||
        /\b(?:synthetic[_\s-]*fixture|fixture[_\s-]*provider|mock[_\s-]*serp|synthetic[_\s-]*serp)\b/i.test(r.sourceUrl ?? ""),
    )
  ) {
    problems.push(
      `${claim.claimId}: synthetic_fixture_research_rejected — Synthetic fixture or mock research evidence cannot satisfy production source authority.`,
    );
  }

  // M13: Loi Hoguet / Carte T statutory proposition verification
  const mentionsHoguet =
    /\b(?:Loi\s+Hoguet|70-9)\b/i.test(text) ||
    claim.sourceRefs.some((r) => /\b(?:Loi\s+Hoguet|70-9|JORFTEXT000000512228)\b/i.test(`${r.ref} ${r.sourceUrl ?? ""}`));
  if (mentionsHoguet) {
    const claimsExemptionOrLicense =
      /\bwithout\s+(?:a\s+|holding\s+a\s+)?carte\s+(?:professionnelle|t)\b/i.test(text) ||
      /\b(?:allows?|permits?)\s+[\w\s-]*?(?:brokerage|intermediation|mandat)\s+without\b/i.test(text) ||
      /\bno\s+carte\s+(?:professionnelle|t)\s+(?:is\s+)?required\b/i.test(text) ||
      /\bSutherland[\w\s-]*(?:holds?|possesses|licensed\s+under)\s+(?:a\s+)?carte\s+(?:professionnelle|t)\b/i.test(text) ||
      /\bSutherland[\w\s-]*(?:executes?|acts\s+under)\s+(?:a\s+)?(?:regulated\s+)?mandat\s+de\s+(?:recherche|vente)\b/i.test(text);
    if (claimsExemptionOrLicense) {
      problems.push(
        `${claim.claimId}: statutory_proposition_mismatch — Loi Hoguet (Law No. 70-9 of 2 January 1970, Art. 1, 3, 6) strictly requires a Carte professionnelle T and prior written mandat for regulated property intermediation; advisory-only practices cannot claim brokerage exemption or regulated brokerage status.`,
      );
    }
  }

  // M14: French statutory DPE energy audit calendar (Loi Climat et Résilience / CCH L126-28-1)
  if (/\benergy\s+audits?\b/i.test(text) && /\bclass(?:es)?\s+[DFG]/i.test(text)) {
    const fgMatch = text.match(/classes?\s+F\s+and\s+G\s+(?:in\s+|\()?(\d{4})/i);
    const eMatch = text.match(/class\s+E\s+(?:in\s+|\()?(\d{4})/i);
    const dMatch = text.match(/class\s+D\s+(?:in\s+|\()?(\d{4})/i);
    const yearsInText = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
    const allowedYears = new Set([2023, 2025, 2034]);
    const badSchedule =
      (fgMatch && Number(fgMatch[1]) !== 2023) ||
      (eMatch && Number(eMatch[1]) !== 2025) ||
      (dMatch && Number(dMatch[1]) !== 2034) ||
      yearsInText.some((y) => !allowedYears.has(y));
    if (badSchedule) {
      problems.push(
        `${claim.claimId}: statutory_schedule_mismatch — French statutory DPE energy audit schedule requires classes F and G in 2023, class E in 2025, and class D in 2034.`,
      );
    }
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

