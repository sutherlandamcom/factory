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
