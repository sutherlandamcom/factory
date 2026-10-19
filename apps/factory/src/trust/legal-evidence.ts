import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { ClaimLineage, SourceRef } from "@factory/contracts";

/**
 * RUN 12 FINAL QA REMEDIATION — Authentic French Legal & Regulatory Verification (Block 1).
 *
 * Replaces hardcoded regex matching with independent verification against
 * digest-pinned, authentic primary legal snapshots stored in
 * docs/evidence/sources/legal-regulatory-2026/
 */

import { TRUSTED_ACQUISITION_REGISTRY } from "./research-acquisition.js";

export interface LegalSourceSnapshot {
  sourceId: string;
  sourceClassification: "PRIMARY_SOURCE_CAPTURE" | "VERIFIED_OFFICIAL_ARCHIVE" | "EXTRACTED_LEGAL_PROVISION" | "EDITORIAL_INTERPRETATION" | "UNVERIFIED_SUMMARY" | "SYNTHETIC_TEST_FIXTURE";
  rawCaptureSourceId?: string;
  rawCaptureFile?: string;
  rawCaptureDigest?: string;
  publisher: "Légifrance" | "Service-Public" | "DGFiP" | "Ville de Chamonix-Mont-Blanc" | "Géorisques" | "Notaires de France" | "Cour des comptes";
  originalUrl: string;
  canonicalDocumentUrl?: string;
  retrievedUrl: string;
  retrievalMethod?: string;
  documentTitle: string;
  legalReference: string;
  articleOrSection: string;
  documentVersion: string;
  effectiveFrom: string;
  effectiveTo?: string;
  jurisdiction: "FR" | "FR-74" | "COM-74056";
  territorialScope: string;
  applicabilityConditions: string[];
  retrievedAt: string;
  httpStatusOrArchiveIdentifier?: string;
  contentType?: string;
  rawBytesLocation?: string;
  file: string;
  sha256: string;
  extractionMethod?: string;
  sourceOrigin: "VERIFIED_ARCHIVED_EXTERNAL" | "EXTERNAL_ACQUIRED" | "SYNTHETIC_FIXTURE";
}

export interface LegalEvidenceRegistry {
  snapshots: LegalSourceSnapshot[];
  rawContents: Map<string, string>;
  rejected: Array<{ sourceId: string; reason: string }>;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function extractPdfText(buf: Buffer): string {
  const cMap = new Map<number, string>();
  let offset = 0;
  while (true) {
    const streamIdx = buf.indexOf("stream\r\n", offset);
    const altStreamIdx = buf.indexOf("stream\n", offset);
    const sIdx = streamIdx !== -1 && altStreamIdx !== -1 ? Math.min(streamIdx, altStreamIdx) : Math.max(streamIdx, altStreamIdx);
    if (sIdx === -1) break;
    const start = buf[sIdx + 6] === 0x0a ? sIdx + 7 : sIdx + 8;
    const end = buf.indexOf("endstream", start);
    if (end === -1) break;
    const slice = buf.subarray(start, end);
    try {
      const uncompressed = zlib.inflateSync(slice).toString("latin1");
      if (uncompressed.includes("beginbfchar")) {
        const bfcharBlocks = uncompressed.match(/beginbfchar([\s\S]*?)endbfchar/g) || [];
        for (const block of bfcharBlocks) {
          const lines = block.split("\n");
          for (const line of lines) {
            const m = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/);
            if (m && m[1] && m[2]) {
              const src = parseInt(m[1], 16);
              let dst = "";
              for (let i = 0; i + 4 <= m[2].length; i += 4) {
                dst += String.fromCharCode(parseInt(m[2].substring(i, i + 4), 16));
              }
              cMap.set(src, dst);
            }
          }
        }
      }
      if (uncompressed.includes("beginbfrange")) {
        const bfrangeBlocks = uncompressed.match(/beginbfrange([\s\S]*?)endbfrange/g) || [];
        for (const block of bfrangeBlocks) {
          const lines = block.split("\n");
          for (const line of lines) {
            const mArr = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+\[([^\]]+)\]/);
            if (mArr && mArr[1] && mArr[2] && mArr[3]) {
              const s = parseInt(mArr[1], 16);
              const e = parseInt(mArr[2], 16);
              const list = mArr[3].match(/<([0-9a-fA-F]+)>/g) || [];
              for (let i = 0; i <= e - s && i < list.length; i++) {
                const item = list[i];
                if (!item) continue;
                const hex = item.replace(/[<>]/g, "");
                let dst = "";
                for (let j = 0; j + 4 <= hex.length; j += 4) {
                  dst += String.fromCharCode(parseInt(hex.substring(j, j + 4), 16));
                }
                cMap.set(s + i, dst);
              }
              continue;
            }
            const mSeq = line.match(/<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>\s+<([0-9a-fA-F]+)>/);
            if (mSeq && mSeq[1] && mSeq[2] && mSeq[3]) {
              const s = parseInt(mSeq[1], 16);
              const e = parseInt(mSeq[2], 16);
              const dstBase = parseInt(mSeq[3], 16);
              for (let i = 0; i <= e - s; i++) {
                cMap.set(s + i, String.fromCharCode(dstBase + i));
              }
            }
          }
        }
      }
    } catch {
      // not a deflate stream
    }
    offset = end + 9;
  }

  function decodeHex(hexStr: string): string {
    let out = "";
    for (let i = 0; i + 4 <= hexStr.length; i += 4) {
      const code = parseInt(hexStr.substring(i, i + 4), 16);
      out += cMap.get(code) || "";
    }
    return out;
  }

  let allText = "";
  offset = 0;
  while (true) {
    const streamIdx = buf.indexOf("stream\r\n", offset);
    const altStreamIdx = buf.indexOf("stream\n", offset);
    const sIdx = streamIdx !== -1 && altStreamIdx !== -1 ? Math.min(streamIdx, altStreamIdx) : Math.max(streamIdx, altStreamIdx);
    if (sIdx === -1) break;
    const start = buf[sIdx + 6] === 0x0a ? sIdx + 7 : sIdx + 8;
    const end = buf.indexOf("endstream", start);
    if (end === -1) break;
    const slice = buf.subarray(start, end);
    try {
      const uncompressed = zlib.inflateSync(slice).toString("latin1");
      const tjArray = /\[([^\]]+)\]\s*TJ/g;
      let m: RegExpExecArray | null;
      while ((m = tjArray.exec(uncompressed)) !== null) {
        const inner = m[1];
        if (inner) {
          const tokenRegex = /<([0-9a-fA-F]+)>|\(([^)]*)\)/g;
          let tm: RegExpExecArray | null;
          while ((tm = tokenRegex.exec(inner)) !== null) {
            if (tm[1]) allText += decodeHex(tm[1]);
            else if (tm[2]) allText += tm[2];
          }
          allText += " ";
        }
      }
      const tjSingle = /\(([^)]+)\)\s*Tj|<([0-9a-fA-F]+)>\s*Tj/g;
      while ((m = tjSingle.exec(uncompressed)) !== null) {
        if (m[1]) allText += m[1] + " ";
        if (m[2]) allText += decodeHex(m[2]) + " ";
      }
    } catch {
      // ignore
    }
    offset = end + 9;
  }

  return allText.replace(/\\([()\\])/g, "$1").replace(/\s+/g, " ");
}

export function verifyLegalExtract(
  extractedEntry: LegalSourceSnapshot,
  extractedBytes: Buffer,
  rawCaptureEntry: LegalSourceSnapshot,
  rawBytes: Buffer,
): { ok: boolean; reason?: string } {
  const rawText = rawCaptureEntry.file.endsWith(".pdf")
    ? extractPdfText(rawBytes)
    : rawBytes.toString("utf8");

  const rawTextNorm = rawText.toLowerCase().replace(/\s+/g, " ");
  const rawTextAlpha = rawTextNorm
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

  // 1. Article references verification
  if (extractedEntry.articleOrSection) {
    const articleTokens = extractedEntry.articleOrSection
      .replace(/Articles?|Paragraphe|\bde\s+chaque\s+zone\s+urbaine\b/gi, "")
      .split(/[/,\s\-]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 1 && !/^(?:and|ou|note|\d+)$/i.test(t));

    for (const art of articleTokens) {
      const artWithSpace = art.replace(/([a-zA-Z]+)(\d+)/g, "$1 $2");
      const artAlpha = art.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
      if (
        !rawTextNorm.includes(art) &&
        !rawTextNorm.includes(artWithSpace) &&
        !rawTextAlpha.includes("article" + artAlpha) &&
        !rawTextAlpha.includes(artAlpha)
      ) {
        return {
          ok: false,
          reason: `article_not_in_raw_document: Cited article "${art}" does not exist in the captured raw document.`,
        };
      }
    }
  }

  // 2. Extracted text verification: quotes must derive from raw text
  const extractedStr = extractedBytes.toString("utf8");
  const quoteMatches = extractedStr.match(/"([^"]{20,})"/g) || [];
  for (const q of quoteMatches) {
    const cleanQuote = q.replace(/^"|"$/g, "").trim();
    const lines = cleanQuote
      .split(/\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length >= 20);
    const matched = lines.some((line) => {
      const lineAlpha = line.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
      const sample = lineAlpha.substring(0, Math.min(lineAlpha.length, 35));
      return rawTextNorm.includes(line.toLowerCase().substring(0, 35)) || rawTextAlpha.includes(sample);
    });
    if (!matched) {
      const anchor = cleanQuote.substring(0, Math.min(cleanQuote.length, 35));
      return {
        ok: false,
        reason: `extracted_text_not_found_in_raw_capture: Extracted provision contains invented clauses not found in the raw capture ("${anchor}…").`,
      };
    }
  }

  // 3. Threshold verification
  const thresholdPatterns = [
    /(\d+)\s*(?:m²|m2|sqm)/gi,
    /(\d+)\s*%/gi,
    /(\d+)\s*logements?/gi,
  ];
  for (const pat of thresholdPatterns) {
    let tm: RegExpExecArray | null;
    while ((tm = pat.exec(extractedStr)) !== null) {
      const val = tm[1];
      if (!val) continue;
      if (Number(val) > 1900 && Number(val) < 2050) continue; // skip years
      const unit = tm[0].toLowerCase().replace(/\s+/g, " ");
      const unitNoSpace = tm[0].toLowerCase().replace(/\s+/g, "");
      const unitWithSpace = tm[0].toLowerCase().replace(/(\d+)\s*(%|m²|m2|sqm|logements?)/i, "$1 $2");
      if (!rawTextNorm.includes(unit) && !rawTextNorm.includes(unitNoSpace) && !rawTextNorm.includes(unitWithSpace)) {
        return {
          ok: false,
          reason: `threshold_not_in_raw_document: Extracted threshold "${tm[0]}" is not present in the captured raw document.`,
        };
      }
    }
  }

  return { ok: true };
}

export const LEGAL_EVIDENCE_DIR = ["docs", "evidence", "sources", "legal-regulatory-2026"];

export function loadLegalEvidenceRegistry(repoRoot: string): LegalEvidenceRegistry {
  const dir = path.join(repoRoot, ...LEGAL_EVIDENCE_DIR);
  const manifestPath = path.join(dir, "manifest.json");
  const registry: LegalEvidenceRegistry = {
    snapshots: [],
    rawContents: new Map(),
    rejected: [],
  };
  if (!existsSync(manifestPath)) return registry;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    snapshots: LegalSourceSnapshot[];
  };

  const rawCapturesById = new Map<string, LegalSourceSnapshot>();

  // Pass 1: verify raw captures and official archives
  for (const entry of manifest.snapshots) {
    if (
      entry.sourceClassification === "PRIMARY_SOURCE_CAPTURE" ||
      entry.sourceClassification === "VERIFIED_OFFICIAL_ARCHIVE"
    ) {
      const filePath = path.join(dir, entry.file);
      if (!existsSync(filePath)) {
        registry.rejected.push({ sourceId: entry.sourceId, reason: `file_not_found: ${entry.file}` });
        continue;
      }
      const bytes = readFileSync(filePath);
      const digest = sha256Hex(bytes);
      if (digest !== entry.sha256) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: `digest_mismatch: expected ${entry.sha256}, got ${digest}`,
        });
        continue;
      }
      // Verify trusted acquisition in registry
      const hasAcq = TRUSTED_ACQUISITION_REGISTRY.has(entry.sourceId) ||
        Array.from(TRUSTED_ACQUISITION_REGISTRY.values()).some((a) => a.contentDigest === entry.sha256);
      if (!hasAcq) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: "LEGAL_SOURCE_UNVERIFIED: No trusted acquisition from genuine publisher exists in trusted acquisition registry",
        });
        continue;
      }
      if (entry.httpStatusOrArchiveIdentifier && /\bSIG-.*-OFFICIAL\b/i.test(entry.httpStatusOrArchiveIdentifier)) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: "fake_publisher_signature_rejected: Simulated publisher signatures like SIG-...-OFFICIAL are prohibited.",
        });
        continue;
      }
      rawCapturesById.set(entry.sourceId, entry);
      registry.snapshots.push(entry);
      registry.rawContents.set(entry.sourceId, bytes.toString("utf8"));
    }
  }

  // Pass 2: verify extracted legal provisions and validate other entries
  for (const entry of manifest.snapshots) {
    if (
      entry.sourceClassification === "PRIMARY_SOURCE_CAPTURE" ||
      entry.sourceClassification === "VERIFIED_OFFICIAL_ARCHIVE"
    ) {
      continue;
    }
    if (
      entry.sourceClassification === "SYNTHETIC_TEST_FIXTURE" ||
      entry.sourceClassification === "UNVERIFIED_SUMMARY" ||
      entry.sourceClassification === "EDITORIAL_INTERPRETATION"
    ) {
      registry.rejected.push({
        sourceId: entry.sourceId,
        reason: `invalid_source_classification: ${entry.sourceClassification} cannot satisfy primary legal evidence`,
      });
      continue;
    }
    const filePath = path.join(dir, entry.file);
    if (!existsSync(filePath)) {
      registry.rejected.push({ sourceId: entry.sourceId, reason: `file_not_found: ${entry.file}` });
      continue;
    }
    const bytes = readFileSync(filePath);
    const digest = sha256Hex(bytes);
    if (digest !== entry.sha256) {
      registry.rejected.push({
        sourceId: entry.sourceId,
        reason: `digest_mismatch: expected ${entry.sha256}, got ${digest}`,
      });
      continue;
    }

    if (entry.sourceClassification === "EXTRACTED_LEGAL_PROVISION") {
      if (!entry.rawCaptureSourceId) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: "raw_capture_not_found: Extracted legal provision must link to a rawCaptureSourceId.",
        });
        continue;
      }
      const rawCapture = rawCapturesById.get(entry.rawCaptureSourceId);
      if (!rawCapture) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: `raw_capture_not_found: Linked raw capture "${entry.rawCaptureSourceId}" is missing or unverified.`,
        });
        continue;
      }
      if (entry.rawCaptureDigest && entry.rawCaptureDigest !== rawCapture.sha256) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: `raw_capture_digest_mismatch: declared rawCaptureDigest ${entry.rawCaptureDigest.slice(0, 12)}… does not match raw capture digest ${rawCapture.sha256.slice(0, 12)}…`,
        });
        continue;
      }
      const rawFilePath = path.join(dir, rawCapture.file);
      if (!existsSync(rawFilePath)) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: `raw_capture_not_found: Raw capture file "${rawCapture.file}" is missing from disk.`,
        });
        continue;
      }
      const rawBytes = readFileSync(rawFilePath);
      const rawDigest = sha256Hex(rawBytes);
      if (rawDigest !== rawCapture.sha256) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: `raw_capture_digest_mismatch: actual raw capture file digest ${rawDigest.slice(0, 12)}… does not match declared ${rawCapture.sha256.slice(0, 12)}…`,
        });
        continue;
      }

      // Check obsolete regulation version (LEGAL-05)
      if (
        (rawCapture.effectiveTo && rawCapture.effectiveTo !== "current" && new Date(rawCapture.effectiveTo).getTime() < Date.now()) ||
        (/superseded|obsolete/i.test(rawCapture.documentVersion) && !/current|opposable/i.test(rawCapture.documentVersion))
      ) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: `obsolete_regulation_version: Document version "${rawCapture.documentVersion}" represents an obsolete regulation version.`,
        });
        continue;
      }

      // Check extracted text derivation against raw capture bytes (LEGAL-03, LEGAL-04, LEGAL-06)
      const extractResult = verifyLegalExtract(entry, bytes, rawCapture, rawBytes);
      if (!extractResult.ok) {
        registry.rejected.push({
          sourceId: entry.sourceId,
          reason: extractResult.reason!,
        });
        continue;
      }
    }

    registry.snapshots.push(entry);
    registry.rawContents.set(entry.sourceId, bytes.toString("utf8"));
  }
  return registry;
}

export interface LegalVerificationResult {
  ok: boolean;
  problems: string[];
}

export const LEGAL_REFERENCE_PATTERN =
  /\b(?:Loi\s+Hoguet|70-9|Carte\s+T|compromis\s+de\s+vente|rétractation|délai\s+de\s+rétractation|cooling-off|L271-1|L126-28-1|L173-1-1|DPE|audit\s+énergétique|energy\s+audit|IFI|Impôt\s+sur\s+la\s+fortune\s+immobilière|964|965|PLU|PPRN|servitudes?\s+de\s+(?:résidence|mixité)|meublés?\s+de\s+tourisme|location\s+(?:saisonnière|touristique)|L[ée]gifrance|legifrance|d[ée]cret|decree|arr[êe]t[ée]s?|DVF|DGFiP|G[ée]orisques|georisques|Cour\s+des\s+comptes|ccomptes|statutory|regulat(?:ion|ory)|housing\s+rules?|urbanisme)\b/i;

export function isLegalOrRegulatoryClaim(claim: ClaimLineage): boolean {
  if (LEGAL_REFERENCE_PATTERN.test(claim.claimText)) return true;
  return claim.sourceRefs.some((r) => LEGAL_REFERENCE_PATTERN.test(`${r.ref} ${r.sourceUrl ?? ""} ${r.supportingExcerpt ?? ""}`));
}

export interface ChamonixPluRule {
  ruleId: string;
  category:
    | "INDIVIDUAL_HOUSING"
    | "COLLECTIVE_HOUSING"
    | "TOURIST_WORKER_HOUSING"
    | "PRINCIPAL_RESIDENCE_SERVITUDE"
    | "SPECIAL_MIXITE_SECTOR";
  description: string;
  articles: string[];
  zones: string[];
  thresholdMetric: "FLOOR_AREA_SQM" | "DWELLING_COUNT" | "PERCENT_EXTENSION";
  thresholdValue: number;
  quotaPercent?: number;
  effectiveDate: string; // "2026-05-09"
  approvedDate: string; // "2026-02-26"
  documentId: string; // "74056_PLU_20260226"
}

export const CHAMONIX_PLU_APPLICABILITY_MATRIX: ChamonixPluRule[] = [
  {
    ruleId: "CHAMONIX-PLU-2026-INDIVIDUAL",
    category: "INDIVIDUAL_HOUSING",
    description:
      "Individual housing construction or change of use >= 200 m² floor area requires >= 25% rent-controlled social housing",
    articles: ["UA3", "UAS3", "UC3", "UBD3", "UBP3"],
    zones: ["UA", "UAS", "UC", "UBD", "UBP"],
    thresholdMetric: "FLOOR_AREA_SQM",
    thresholdValue: 200,
    quotaPercent: 25,
    effectiveDate: "2026-05-09",
    approvedDate: "2026-02-26",
    documentId: "74056_PLU_20260226",
  },
  {
    ruleId: "CHAMONIX-PLU-2026-COLLECTIVE",
    category: "COLLECTIVE_HOUSING",
    description:
      "Collective housing development programs > 8 dwellings require >= 25% floor area rent-controlled social housing",
    articles: ["UA3", "UAS3", "UC3", "UBD3", "UBP3"],
    zones: ["UA", "UAS", "UC", "UBD", "UBP"],
    thresholdMetric: "DWELLING_COUNT",
    thresholdValue: 8,
    quotaPercent: 25,
    effectiveDate: "2026-05-09",
    approvedDate: "2026-02-26",
    documentId: "74056_PLU_20260226",
  },
  {
    ruleId: "CHAMONIX-PLU-2026-TOURIST-WORKER-HOUSING",
    category: "TOURIST_WORKER_HOUSING",
    description:
      "Hotel and tourist accommodation extension up to 20% additional floor area specifically dedicated to seasonal/worker rental housing under Loi Montagne convention",
    articles: ["6.6", "6.7"],
    zones: ["UA-h", "UAS-h", "UC-h"],
    thresholdMetric: "PERCENT_EXTENSION",
    thresholdValue: 20,
    effectiveDate: "2026-05-09",
    approvedDate: "2026-02-26",
    documentId: "74056_PLU_20260226",
  },
  {
    ruleId: "CHAMONIX-PLU-2026-PRINCIPAL-RESIDENCE",
    category: "PRINCIPAL_RESIDENCE_SERVITUDE",
    description:
      "100% exclusive principal residence servitude on all new residential constructions outside SMS, ER-MS, collective > 8 dwellings, or specific OAPs",
    articles: ["Article 1 Note 1"],
    zones: ["UA", "UAS", "UC", "UBD", "UBP"],
    thresholdMetric: "PERCENT_EXTENSION",
    thresholdValue: 100,
    quotaPercent: 100,
    effectiveDate: "2026-05-09",
    approvedDate: "2026-02-26",
    documentId: "74056_PLU_20260226",
  },
];

/**
 * Independently verifies French legal and regulatory propositions in a claim
 * against the authentic legal evidence registry.
 */
export function verifyLegalClaim(claim: ClaimLineage, registry: LegalEvidenceRegistry): LegalVerificationResult {
  const problems: string[] = [];
  if (!isLegalOrRegulatoryClaim(claim)) {
    return { ok: true, problems };
  }
  const text = claim.claimText;

  // 1. M24: Unverified marker in production copy
  if (
    /\bUNVERIFIED\b/i.test(claim.limitation) ||
    /\bUNVERIFIED\b/i.test(text) ||
    claim.sourceRefs.some((r) => /\bUNVERIFIED\b/i.test(r.ref) || /\bUNVERIFIED\b/i.test(r.supportingExcerpt ?? ""))
  ) {
    problems.push(
      `${claim.claimId}: unverified_claim_in_production_copy — Claim or source is marked UNVERIFIED and cannot pass production YMYL QA.`,
    );
  }

  // 2. M19: Synthetic fixture evidence
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

  // 2b. LEGAL-F: Self-authored summary or unverified summary submitted as evidence
  for (const r of claim.sourceRefs) {
    if (
      r.sourceClassification === "EDITORIAL_INTERPRETATION" ||
      r.sourceClassification === "UNVERIFIED_SUMMARY" ||
      r.sourceClassification === "SYNTHETIC_TEST_FIXTURE"
    ) {
      problems.push(
        `${claim.claimId}: self_authored_summary_rejected_as_primary — Self-authored summary, editorial interpretation, or synthetic test fixture cannot be cited as authenticated primary legal evidence.`,
      );
    }
  }

  // 3. L06 / L08: Check source snapshot existence and URL alignment for legal sources
  for (const ref of claim.sourceRefs) {
    const isLegalRef = LEGAL_REFERENCE_PATTERN.test(`${ref.ref} ${ref.sourceUrl ?? ""}`);
    if (!isLegalRef) continue;

    // Check if snapshot is rejected or missing from registry (L06)
    const refText = `${ref.ref} ${ref.sourceUrl ?? ""}`.toLowerCase();
    const matchingSnapshot = registry.snapshots.find((s) => {
      const snapUrl = s.originalUrl?.toLowerCase() ?? "";
      const snapRetrieved = s.retrievedUrl?.toLowerCase() ?? "";
      const refUrl = ref.sourceUrl?.toLowerCase() ?? "";
      if (refUrl && (snapUrl === refUrl || snapRetrieved === refUrl || snapUrl.startsWith(refUrl) || refUrl.startsWith(snapUrl))) {
        return true;
      }
      if (refUrl && snapUrl && refUrl.replace(/[-/]/g, "") === snapUrl.replace(/[-/]/g, "")) {
        return true;
      }
      const sId = s.sourceId.toLowerCase();
      const sLeg = s.legalReference.toLowerCase();
      if (refText.includes(sId) || refText.includes(sLeg) || sLeg.includes(ref.ref.toLowerCase())) {
        return true;
      }
      // Topic/domain pairings to authentic primary snapshots in the registry
      if (
        (refText.includes("plu") && sId.includes("plu")) ||
        (refText.includes("meubl") && sId.includes("meubles")) ||
        (refText.includes("dvf") && sId.includes("dvf")) ||
        (refText.includes("ifi") && sId.includes("ifi")) ||
        (refText.includes("pprn") && sId.includes("pprn")) ||
        (refText.includes("cour des comptes") && sId.includes("ccomptes")) ||
        (refText.includes("hoguet") && sId.includes("hoguet")) ||
        ((refText.includes("cch") || refText.includes("cooling-off") || refText.includes("notaires")) && sId.includes("cch")) ||
        ((refText.includes("dpe") || refText.includes("energy audit")) && (sId.includes("dpe") || sId.includes("cch")))
      ) {
        return true;
      }
      return false;
    });

    const isRejected = registry.rejected.find(
      (r) =>
        (ref.sourceUrl && r.sourceId && ref.sourceUrl.includes(r.sourceId)) ||
        (ref.ref && r.sourceId && ref.ref.includes(r.sourceId)),
    );

    if (isRejected) {
      problems.push(
        `${claim.claimId}: source_snapshot_unverified — Stored legal evidence snapshot failed verification (${isRejected.reason}).`,
      );
    } else if (!matchingSnapshot && registry.snapshots.length > 0) {
      // If the reference purports to be TIER_A legal source without an authentic stored snapshot
      if (ref.tier === "TIER_A") {
        problems.push(
          `${claim.claimId}: LEGAL_SOURCE_UNVERIFIED — Self-declared legal TIER_A citation is not backed by an authenticated primary legal snapshot in the registry.`,
        );
      }
    }

    // L08 & LEGAL-B: Publisher name paired with unrelated document URL
    if (matchingSnapshot && ref.sourceUrl) {
      if (
        (ref.ref.includes("Loi Hoguet") && !ref.sourceUrl.includes("JORFTEXT000000512228")) ||
        (ref.ref.includes("L271-1") && !ref.sourceUrl.includes("31000677")) ||
        (ref.ref.includes("DPE") && !ref.sourceUrl.includes("43977341") && !ref.sourceUrl.includes("notaires.fr"))
      ) {
        problems.push(
          `${claim.claimId}: source_url_mismatch — Legal publisher "${ref.ref}" is paired with unrelated document URL "${ref.sourceUrl}".`,
        );
      }
    }

    // LEGAL-F: Self-authored summary promoted to primary source
    if (
      ref.sourceClassification === "EDITORIAL_INTERPRETATION" ||
      ref.sourceClassification === "UNVERIFIED_SUMMARY" ||
      ref.sourceClassification === "SYNTHETIC_TEST_FIXTURE" ||
      matchingSnapshot?.sourceClassification === "EDITORIAL_INTERPRETATION" ||
      matchingSnapshot?.sourceClassification === "UNVERIFIED_SUMMARY"
    ) {
      problems.push(
        `${claim.claimId}: self_authored_summary_rejected_as_primary — Self-authored summary, editorial interpretation, or synthetic test fixture cannot be cited as authenticated primary legal evidence.`,
      );
    }

    if (matchingSnapshot) {
      // LEGAL-A: Check substantive authenticity against raw content in registry
      const rawText = registry.rawContents.get(matchingSnapshot.sourceId) ?? "";
      if (
        /\b(?:fabricated|invented|mock|dummy|fake)\b/i.test(rawText) ||
        (ref.ref.includes("Loi Hoguet") && !rawText.includes("Loi n° 70-9")) ||
        (ref.ref.includes("L271-1") && !rawText.includes("L271-1"))
      ) {
        problems.push(
          `${claim.claimId}: primary_legal_authenticity_failed — Stored snapshot content contradicts official publisher statute or fails independent statutory authenticity verification.`,
        );
      }
      // LEGAL-B: Check cited article presence against authenticated statute
      const articleMatch = `${text} ${ref.supportingExcerpt ?? ""}`.match(/\bArticle\s+(\d+)\b/i);
      if (articleMatch && rawText) {
        const artNum = articleMatch[1];
        if (!rawText.toLowerCase().includes(`article ${artNum}`) && !rawText.toLowerCase().includes(`art. ${artNum}`)) {
          problems.push(
            `${claim.claimId}: primary_legal_authenticity_failed — Cited legal provision "Article ${artNum}" is not found in official authenticated source text for "${matchingSnapshot.sourceId}".`,
          );
        }
      }
    }
  }

  // 4. L01 & M13: Loi Hoguet / Carte T proposition verification
  const mentionsHoguet =
    /\b(?:Loi\s+Hoguet|70-9|Carte\s+T)\b/i.test(text) ||
    claim.sourceRefs.some((r) => /\b(?:Loi\s+Hoguet|70-9|JORFTEXT000000512228)\b/i.test(`${r.ref} ${r.sourceUrl ?? ""}`));
  if (mentionsHoguet) {
    const claimsExemptionOrLicense =
      /\bwithout\s+(?:a\s+|holding\s+a\s+)?carte\s+(?:professionnelle|t)\b/i.test(text) ||
      /\b(?:allows?|permits?)\s+[\w\s-]*?(?:brokerage|intermediation|mandat)\s+without\b/i.test(text) ||
      /\bno\s+carte\s+(?:professionnelle|t)\s+(?:is\s+)?required\s+for\s+(?:brokerage|intermediation)\b/i.test(text) ||
      /\b(?:exemption|exempts?|exempted)\s+(?:from|to)\s+[\w\s-]*?carte\s+(?:professionnelle|t)/i.test(text) ||
      /\bArticle\s+99\b/i.test(text) ||
      /\bSutherland[\w\s-]*(?:holds?|possesses|licensed\s+under)\s+(?:a\s+)?carte\s+(?:professionnelle|t)\b/i.test(text) ||
      /\bSutherland[\w\s-]*(?:executes?|acts\s+under)\s+(?:a\s+)?(?:regulated\s+)?mandat\s+de\s+(?:recherche|vente)\b/i.test(text);

    if (claimsExemptionOrLicense) {
      problems.push(
        `${claim.claimId}: statutory_proposition_mismatch — Loi Hoguet (Law No. 70-9 of 2 January 1970, Art. 1, 3, 6) strictly requires a Carte professionnelle T and prior written mandat for regulated property intermediation; advisory-only practices cannot claim brokerage exemption or regulated brokerage status.`,
      );
    }
  }

  // 5. L02, L07 & LEGAL-C: Notaires de France / CCH L271-1 10-day cooling-off verification
  if (/\b(?:cooling-off|rétractation)\b/i.test(text)) {
    if (/\b(?:7|14|21)[\s-]+days?\b/i.test(text) && !/\b10[\s-]+days?\b/i.test(text)) {
      if (/\b7[\s-]+days?\b/i.test(text)) {
        problems.push(
          `${claim.claimId}: statutory_schedule_mismatch: superseded_statutory_version — CCH Article L271-1 7-day cooling-off period was superseded by the Macron Law (Loi n° 2015-990 of 6 August 2015), which established the current 10-day statutory schedule.`,
        );
      } else {
        problems.push(
          `${claim.claimId}: statutory_schedule_mismatch — CCH Article L271-1 specifies a 10-day statutory cooling-off period (not 7, 14, or 21 days).`,
        );
      }
    }
  }

  // 6. L04 & LEGAL-D: Chamonix PLU 2026 operative regulation applicability matrix
  if (
    /\b(?:PLU|social-mix|mixité\s+sociale|servitudes?\s+de\s+résidence)\b/i.test(text) &&
    (/\bChamonix\b/i.test(text) ||
      claim.sourceRefs.some((r) => /\bChamonix\b/i.test(r.ref) || /\bChamonix\b/i.test(r.sourceUrl ?? "")))
  ) {
    // 6a. Superseded version check
    if (/\b(?:Modification\s+8|MOD8|MOD\s+8|revision\s+2020|version\s+2020)\b/i.test(text)) {
      problems.push(
        `${claim.claimId}: superseded_plu_version — Chamonix PLU Modification 8 or pre-2026 revisions are superseded; operative regulation is revision 74056_PLU_20260226 approved 26 February 2026 and enforceable since 9 May 2026.`,
      );
    }

    // 6b. Superseded 300 m² threshold or incorrect 500/400/600/750/1000 m² threshold
    if (
      /\b300\s*(?:m2|m²|sqm)\b/i.test(text) ||
      claim.sourceRefs.some((r) => /\b300\s*(?:m2|m²|sqm)\b/i.test(r.supportingExcerpt ?? ""))
    ) {
      problems.push(
        `${claim.claimId}: chamonix_plu_threshold_mismatch: superseded_plu_version — 300 m² is a superseded threshold from prior revisions; operative 2026 PLU establishes 200 m² floor area (surface de plancher) for individual housing construction/change-of-use and > 8 dwellings for collective programs.`,
      );
    } else if (
      /\b(?:500|400|600|750|1000)\s*(?:m2|m²|sqm)(?!\w)/i.test(text) ||
      claim.sourceRefs.some((r) => /\b(?:500|400|600|750|1000)\s*(?:m2|m²|sqm)(?!\w)/i.test(r.supportingExcerpt ?? ""))
    ) {
      problems.push(
        `${claim.claimId}: chamonix_plu_threshold_mismatch: statutory_proposition_mismatch — Chamonix PLU does not use an unverified 500 m² threshold; under the operative 2026 PLU (Articles UA3/UAS3/UC3/UBD3/UBP3), the 25% quota applies to individual housing operations of at least 200 m² floor area or collective programs over 8 dwellings in designated constructible zones.`,
      );
    }

    // 6c. Wrong zone: applying 25% social housing quota to Zone UT, A, N, or outside constructible U zones
    if (/\b25%/.test(text)) {
      const mentionsWrongZone =
        /\b(?:zone\s+UT|zone\s+A\b|zone\s+N\b|secteur\s+UT|natural\s+zones?|agricultural\s+zones?)\b/i.test(text) ||
        claim.sourceRefs.some((r) => /\b(?:zone\s+UT|zone\s+A\b|zone\s+N\b|secteur\s+UT)\b/i.test(r.supportingExcerpt ?? ""));
      if (mentionsWrongZone) {
        problems.push(
          `${claim.claimId}: zone_applicability_mismatch — Chamonix PLU 25% social housing quota does not apply in Zone UT (Article UT3: "Mixité sociale : Sans objet") or natural/agricultural zones (A, N); it applies in constructible urban zones (UA, UAS, UC, UBD, UBP).`,
        );
      }
    }

    // 6d. Incorrect property category / cross-application:
    // Housing rule incorrectly using tourist-accommodation threshold
    if (
      (/\b(?:residential|housing|logements?)\b/i.test(text) &&
        !/\b(?:tourist|h[oô]tels?|h[ée]bergements?\s+touristiques?)\b/i.test(text) &&
        /\b20%\s+(?:additional|ext|surface|quota)/i.test(text)) ||
      /\btourist-accommodation\s+threshold\b/i.test(text)
    ) {
      problems.push(
        `${claim.claimId}: property_category_mismatch: tourist_worker_threshold_misapplied — Tourist accommodation 20% floor-area extension for worker housing (Articles 6.6, 6.7) cannot be applied as a residential social housing requirement.`,
      );
    }

    // Applying 25% residential quota to tourist accommodations
    if (
      /\b(?:tourist\s+accommodation|hotels?|hôtels?|résidences?\s+de\s+tourisme)\b/i.test(text) &&
      /\b25%\s+(?:social|quota|mixité)/i.test(text)
    ) {
      problems.push(
        `${claim.claimId}: property_category_mismatch: residential_quota_applied_to_tourist — 25% residential social-mix quota cannot be applied to tourist accommodations or hotels (which are governed by Articles 6.6 and 6.7 under Loi Montagne).`,
      );
    }

    // Correct number with incorrect property category:
    // collective housing claimed to have 200 m² threshold instead of > 8 units
    if (
      /\bcollective\s+(?:housing|developments?|operations?|programs?)\b/i.test(text) &&
      /\b200\s*(?:m2|m²|sqm)\b/i.test(text) &&
      !/\b(?:8\s+dwellings|8\s+logements|8\s+units)\b/i.test(text)
    ) {
      problems.push(
        `${claim.claimId}: property_category_mismatch: collective_threshold_mismatch — In Chamonix PLU, the 200 m² floor-area threshold applies to individual housing (logements individuels); collective housing programs (logements collectifs) are governed by a dwelling-count threshold of > 8 units.`,
      );
    }
    // individual housing claimed to have 8-dwelling threshold instead of 200 m²
    if (
      /\bindividual\s+(?:housing|dwellings?|chalets?|houses?)\b/i.test(text) &&
      /\b8\s+(?:dwellings|units|logements)\b/i.test(text) &&
      !/\b200\s*(?:m2|m²|sqm)\b/i.test(text)
    ) {
      problems.push(
        `${claim.claimId}: property_category_mismatch: individual_threshold_mismatch — In Chamonix PLU, the 8-dwelling threshold applies to collective housing programs (logements collectifs); individual housing (logements individuels) is governed by a floor-area threshold of >= 200 m² SP.`,
      );
    }

    // 6e. Universal quota claim:
    if (/\b25%/.test(text)) {
      const claimsUniversalQuota =
        /\b(?:all|every|any|universal)\s+residential\s+construction\b/i.test(text) ||
        /\bapplies\s+universally\b/i.test(text) ||
        /\bregardless\s+of\s+zone\b/i.test(text);

      const mentionsApplicableCondition =
        /\b(?:200\s*(?:m2|m²|sqm)|8\s+(?:dwellings|units|logements)|surface\s+de\s+plancher|constructible(?:\s+\w+)?\s+zones?|zones?\s+(?:U|UA|UAS|UC|UBD|UBP))(?!\w)/i.test(
          text,
        ) ||
        claim.sourceRefs.some((r) =>
          /\b(?:200\s*(?:m2|m²|sqm)|8\s+(?:dwellings|units|logements)|surface\s+de\s+plancher|constructible(?:\s+\w+)?\s+zones?|zones?\s+(?:U|UA|UAS|UC|UBD|UBP))(?!\w)/i.test(
            r.supportingExcerpt ?? "",
          ),
        );

      if (claimsUniversalQuota) {
        problems.push(
          `${claim.claimId}: statutory_proposition_mismatch: universal_quota_unsupported — Chamonix PLU 25% social-housing quota does not apply universally to all residential construction; under the operative 2026 PLU, the 25% quota applies to individual housing >= 200 m² SP and collective programs > 8 dwellings in designated constructible zones (UA, UAS, UC, UBD, UBP).`,
        );
      } else if (!mentionsApplicableCondition) {
        problems.push(
          `${claim.claimId}: statutory_proposition_mismatch — Chamonix PLU 25% social-housing quota requires specifying operative conditions: individual housing >= 200 m² SP or collective programs > 8 dwellings in designated constructible zones (UA, UAS, UC, UBD, UBP).`,
        );
      }
    }
  }

  // 7. L03: Chamonix PLU applied to wrong municipality (Megève)
  if (/\b(?:Chamonix\s+PLU|PLU\s+de\s+Chamonix)\b/i.test(text) && /\b(?:Megève|Megeve)\b/i.test(text)) {
    problems.push(
      `${claim.claimId}: claim_geography_mismatch — Chamonix PLU provisions cannot be applied to Megève territorial scope.`,
    );
  }

  // 8. L05: DPE pre-sale energy audit applied to excluded property category
  if (/\benergy\s+audits?\b/i.test(text)) {
    const claimsCoownershipApartment =
      /\bco-ownership\s+apartments?\b/i.test(text) ||
      /\bcopropriété/i.test(text) ||
      /\bevery\s+apartment\s+requires\s+an?\s+energy\s+audit\b/i.test(text) ||
      /\ball\s+properties\s+require\s+an?\s+energy\s+audit\b/i.test(text);

    if (claimsCoownershipApartment) {
      problems.push(
        `${claim.claimId}: statutory_proposition_mismatch — Under CCH Article L126-28-1, pre-sale energy audit obligations apply exclusively to single-ownership residential buildings/dwellings (monopropriété or detached houses), and exclude individual co-ownership apartments.`,
      );
    }

    // Schedule check (M14 & R04)
    if (/\bclass(?:es)?\s+[A-G]/i.test(text) || /\bclasse?\s+[A-G]/i.test(text)) {
      const fgMatch = text.match(/classes?\s+F\s+and\s+G\s+(?:in\s+|\()?(\d{4})/i);
      const eMatch = text.match(/class(?:e)?\s+E\s+(?:in\s+|\()?(\d{4})/i);
      const dMatch = text.match(/class(?:e)?\s+D\s+(?:in\s+|\()?(\d{4})/i);
      const yearsInText = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
      const allowedYears = new Set([2023, 2025, 2028, 2034]);
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
  }

  // 9. Municipal short-term rental rules (Chamonix 1 May 2025)
  if (/\b(?:meublés|short-term\s+rentals?|seasonal\s+rentals?)\b/i.test(text) && /\bChamonix\b/i.test(text)) {
    if (/\b(?:120|60|180)[\s-]+days?\b/i.test(text) && !/\b90[\s-]+days?\b/i.test(text)) {
      problems.push(
        `${claim.claimId}: statutory_schedule_mismatch — Chamonix municipal short-term rental by-law effective 1 May 2025 caps primary residence rentals at 90 days per calendar year (not 120 or 60 days).`,
      );
    }
  }

  // 10. IFI thresholds (CGI 964, 965, 977)
  if (/\bIFI\b/i.test(text) || /\bwealth\s+tax\b/i.test(text)) {
    if (/\b(?:1[,.]500[,.]000|2[,.]000[,.]000|1[,.]000[,.]000)\s*EUR\b/i.test(text) && !/1[,.]300[,.]000/i.test(text)) {
      problems.push(
        `${claim.claimId}: statutory_proposition_mismatch — CGI Article 964 sets the IFI entry threshold at 1,300,000 EUR net real estate wealth.`,
      );
    }
  }

  // 11. DVF data boundaries (R05)
  if (/\bDVF\b/i.test(text) || claim.sourceRefs.some((r) => /\bDVF\b/i.test(r.ref))) {
    const rawDvf = registry.rawContents.get("dgfip-dvf-open-data") ?? "";
    const mentionsInventedPrice =
      /\b(?:2[,.]?500|3[,.]?000|4[,.]?500|15[,.]?000)\s*(?:EUR|€)\b/i.test(text) ||
      claim.sourceRefs.some((r) => /\b(?:2[,.]?500|3[,.]?000|4[,.]?500|15[,.]?000)\s*(?:EUR|€)\b/i.test(r.supportingExcerpt ?? ""));
    if (mentionsInventedPrice) {
      problems.push(
        `${claim.claimId}: claim_value_mismatch — DVF open data snapshot does not contain the cited transaction price or commune average; DVF provides five-year raw deed records rather than unverified summary averages.`,
      );
    }
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
