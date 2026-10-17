import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  derivedSharePercent,
  extractInseeFacts,
  inseeSourceUrl,
  sha256Hex,
  verifyNumericClaim,
  type ExtractedSourceFact,
  type NumericClaim,
  type SourceEvidenceSnapshot,
} from "../src/trust/insee-evidence.js";

/**
 * RUN 12 REMEDIATION — source-integrity mutation tests (INSEE subset:
 * M01–M06, M12, M18) run against the ACTUAL stored official INSEE bytes,
 * acquired 2026-10-18 from https://www.insee.fr/fr/statistiques/8581193.
 * The incorrect claim is never paired with a matching incorrect source.
 */

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/evidence/sources/insee-logement-2022");

const SNAPSHOTS: Record<string, { digest: string; name: string }> = {
  "74056": { digest: "9f9b23b55b98d4eb36e6363e2a7dad0e4f8f25db0b5f35cec5834570f3624150", name: "Chamonix-Mont-Blanc" },
  "74173": { digest: "929215205222683cff2563d2063692b8c87b33e5fffbb72940f84a64765015a4", name: "Megève" },
};

function load(geo: string, overrideBytes?: Buffer) {
  const bytes = overrideBytes ?? readFileSync(path.join(dir, `COM-${geo}.html`));
  const snapshot: SourceEvidenceSnapshot = {
    sourceId: `insee-logement-2022-${geo}`,
    sourceOrigin: "EXTERNAL_ACQUIRED",
    originalUrl: inseeSourceUrl(geo),
    publisher: "INSEE",
    documentTitle: "Logement en 2022",
    geoCode: geo,
    reportingYear: 2022,
    rawContentDigest: SNAPSHOTS[geo]!.digest,
    storedEvidenceLocation: `docs/evidence/sources/insee-logement-2022/COM-${geo}.html`,
    contentType: "text/html",
  };
  return { snapshot, facts: extractInseeFacts(snapshot, bytes), bytes };
}

const all: ExtractedSourceFact[] = [...load("74056").facts, ...load("74173").facts];

const claim = (over: Partial<NumericClaim>): NumericClaim => ({
  geoCode: "74056",
  reportingYear: 2022,
  tableId: "LOG T1",
  rowKey: "Ensemble",
  columnKey: "2022",
  value: 14538,
  unit: "dwellings",
  ...over,
});

test("stored INSEE snapshots hash to the accepted digests", () => {
  for (const geo of ["74056", "74173"]) {
    assert.equal(sha256Hex(readFileSync(path.join(dir, `COM-${geo}.html`))), SNAPSHOTS[geo]!.digest);
  }
});

test("POSITIVE: official 2022 values verify (Chamonix + Megève)", () => {
  const ok: NumericClaim[] = [
    claim({}),
    claim({ tableId: "LOG T1bis", rowKey: "Résidences principales", value: 29.7, unit: "percent_of_dwellings" }),
    claim({ tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", value: 69.3, unit: "percent_of_dwellings" }),
    claim({ tableId: "LOG T1bis", rowKey: "Logements vacants", value: 1.1, unit: "percent_of_dwellings" }),
    claim({ tableId: "LOG T2", rowKey: "Appartements", columnKey: "2022:share", value: 72.6, unit: "percent_of_dwellings" }),
    claim({ geoCode: "74173", rowKey: "Ensemble", value: 9354 }),
    claim({ geoCode: "74173", tableId: "LOG T1bis", rowKey: "Résidences principales", value: 16.1, unit: "percent_of_dwellings" }),
    claim({ geoCode: "74173", tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", value: 82.9, unit: "percent_of_dwellings" }),
    claim({ geoCode: "74173", tableId: "LOG T1bis", rowKey: "Logements vacants", value: 1.0, unit: "percent_of_dwellings" }),
    claim({ geoCode: "74173", tableId: "LOG T2", rowKey: "Appartements", columnKey: "2022:share", value: 81.1, unit: "percent_of_dwellings" }),
  ];
  for (const c of ok) assert.equal(verifyNumericClaim(c, all).status, "VERIFIED", JSON.stringify(c));
});

function expectFail(c: NumericClaim, code: string) {
  const r = verifyNumericClaim(c, all);
  assert.equal(r.status, "FAIL", JSON.stringify(c));
  assert.equal(r.status === "FAIL" && r.code, code);
  return r;
}

test("M01 Chamonix 2022 total 13,864 -> claim_value_mismatch against real source value 14 538", () => {
  const r = expectFail(claim({ value: 13864 }), "claim_value_mismatch");
  assert.match((r as { detail: string }).detail, /14 538/);
});
test("M02 Megève 2022 total 11,291 -> claim_value_mismatch (real 9 354)", () => {
  const r = expectFail(claim({ geoCode: "74173", value: 11291 }), "claim_value_mismatch");
  assert.match((r as { detail: string }).detail, /9 354/);
});
test("M03 Chamonix secondary homes 69.2% -> claim_value_mismatch (real 69,3)", () => {
  expectFail(claim({ tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", value: 69.2, unit: "percent_of_dwellings" }), "claim_value_mismatch");
});
test("M04 actual 2022 value labelled 2023 -> claim_year_mismatch", () => {
  expectFail(claim({ reportingYear: 2023, columnKey: "2023" }), "claim_year_mismatch");
});
test("M05 Chamonix commune ID replaced by Megève ID (Chamonix value, Megève geography) -> claim_value_mismatch; unknown commune -> claim_geography_mismatch", () => {
  expectFail(claim({ geoCode: "74173", value: 14538 }), "claim_value_mismatch");
  expectFail(claim({ geoCode: "74999" }), "claim_geography_mismatch");
});
test("M06 correct number, wrong unit -> claim_unit_mismatch", () => {
  expectFail(claim({ unit: "percent_of_dwellings" }), "claim_unit_mismatch");
});
test("M12 source snapshot altered after digest acceptance -> insee_snapshot_digest_mismatch", () => {
  const original = readFileSync(path.join(dir, "COM-74056.html"));
  const tampered = Buffer.from(original.toString("utf8").replace(/14(?:&nbsp;|\s)538/, "13 864"));
  assert.notEqual(sha256Hex(tampered), sha256Hex(original), "mutation must actually change the bytes");
  assert.throws(() => load("74056", tampered), /insee_snapshot_digest_mismatch/);
});
test("M18 Megève claim justified with Chamonix snapshot -> geography mismatch detected at extraction", () => {
  const chamonixBytes = readFileSync(path.join(dir, "COM-74056.html"));
  const snap: SourceEvidenceSnapshot = { ...load("74173").snapshot, rawContentDigest: SNAPSHOTS["74056"]!.digest };
  assert.throws(() => extractInseeFacts(snap, chamonixBytes), /insee_snapshot_geography_mismatch/);
});
test("year/commune identity: Chamonix 69.3% and Megève 82.9% bind to distinct records", () => {
  const a = verifyNumericClaim(claim({ tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", value: 69.3, unit: "percent_of_dwellings" }), all);
  const b = verifyNumericClaim(claim({ geoCode: "74173", tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", value: 82.9, unit: "percent_of_dwellings" }), all);
  assert.ok(a.status === "VERIFIED" && b.status === "VERIFIED");
  assert.notEqual(a.fact.geoCode, b.fact.geoCode);
  assert.equal(verifyNumericClaim(claim({ tableId: "LOG T1bis", rowKey: "Résidences secondaires et logements occasionnels", value: 82.9, unit: "percent_of_dwellings" }), all).status, "FAIL");
});

test("derived: 1946-1990 construction share for Chamonix main residences = 58.5% (2 475 / 4 231), not 58.2%", () => {
  const t5 = (row: string) => all.find((f) => f.geoCode === "74056" && f.tableId === "LOG T5" && f.rowKey === row && f.columnKey === "count")!.parsedValue;
  const total = t5("Résidences principales construites avant 2020");
  const sum = t5("De 1946 à 1970") + t5("De 1971 à 1990");
  assert.equal(total, 4231);
  assert.equal(sum, 2475);
  assert.equal(derivedSharePercent(sum, total), 58.5);
  assert.notEqual(derivedSharePercent(sum, total), 58.2);
});
test("derived: Chamonix 2006-2019 share is 13.5% of main residences built before 2020 (not 'only 6.0%')", () => {
  const f = all.find((x) => x.geoCode === "74056" && x.tableId === "LOG T5" && x.rowKey === "De 2006 à 2019" && x.columnKey === "share")!;
  assert.equal(f.parsedValue, 13.5);
});
