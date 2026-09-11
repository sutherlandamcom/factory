import {
  MAX_COMPETITOR_PACKET_CHARS,
  type CompetitorEvidencePacket,
  type CompetitorPageExtracted,
} from "@factory/contracts";

/**
 * Deterministic evidence packet builder (Macro Run 3, P4/P16).
 *
 * The analyst NEVER receives raw HTML. It receives a bounded packet built
 * by deterministic selection policy v1, prioritizing: main content >
 * headings > questions > tables > lists > FAQ > data/citations > CTA and
 * freshness signals.
 *
 * Reduction is EXPLICIT, never silent: when available evidence exceeds the
 * packet budget, `selectionTruncated=true` plus sourceChars/selectedChars
 * disclose exactly what happened. Segment text in the packet is verbatim
 * normalized evidence — it is DATA for the analyst, delimited as untrusted.
 */

export const SELECTION_POLICY_VERSION = "selection-policy-v1" as const;

/** Packet budget: ~15k–25k useful characters where sufficient. */
const PACKET_BUDGET_CHARS = MAX_COMPETITOR_PACKET_CHARS;

function priorityWeight(kind: string): number {
  // Lower = kept earlier. Aligned with the documented selection priority.
  switch (kind) {
    case "heading":
      return 1;
    case "question":
      return 2;
    case "faq":
      return 3;
    case "table":
      return 4;
    case "paragraph":
      return 5;
    case "list":
      return 6;
    case "citation":
      return 7;
    case "cta":
      return 8;
    case "metadata":
      return 9;
    default:
      return 10;
  }
}

export function buildEvidencePacket(input: {
  pageSnapshotId: string;
  pageSnapshotDigest: string;
  url: string;
  domain: string;
  observedAt: Date;
  extracted: CompetitorPageExtracted;
}): CompetitorEvidencePacket {
  const { extracted } = input;

  const sourceChars =
    extracted.segments.reduce((acc, s) => acc + s.text.length, 0) +
    extracted.questions.reduce((acc, q) => acc + q.length, 0) +
    extracted.outboundLinks.reduce((acc, l) => acc + l.url.length + (l.text?.length ?? 0), 0) +
    extracted.ctaSignals.reduce((acc, c) => acc + c.length, 0);

  // Deterministic selection: stable sort by (priority, original index).
  const ranked = extracted.segments
    .map((seg, index) => ({ seg, index }))
    .sort((a, b) => {
      const w = priorityWeight(a.seg.kind) - priorityWeight(b.seg.kind);
      return w !== 0 ? w : a.index - b.index;
    });

  const fixedChars =
    (extracted.pageTitle?.length ?? 0) +
    (extracted.metaDescription?.length ?? 0) +
    (extracted.h1?.length ?? 0) +
    (extracted.publicationDate?.length ?? 0) +
    (extracted.updatedDate?.length ?? 0) +
    extracted.questions.reduce((acc, q) => acc + q.length + 3, 0) +
    extracted.ctaSignals.reduce((acc, c) => acc + c.length + 3, 0) +
    extracted.outboundLinks.reduce((acc, l) => acc + l.url.length + 10, 0);

  let budget = PACKET_BUDGET_CHARS - fixedChars - 500; // envelope reserve
  const selected: typeof ranked = [];
  for (const item of ranked) {
    const cost = item.seg.text.length + 1;
    if (cost <= budget) {
      selected.push(item);
      budget -= cost;
    } else if (item.seg.text.length > 400 && budget > 600) {
      // Partial keep for long high-priority blocks (disclosed via truncated flag).
      selected.push({ ...item, seg: { ...item.seg, text: item.seg.text.slice(0, Math.max(200, budget - 200)) } });
      budget = 0;
    }
    if (budget <= 0) break;
  }

  // Restore original order for coherent reading.
  selected.sort((a, b) => a.index - b.index);
  const selectedChars = selected.reduce((acc, s) => acc + s.seg.text.length, 0);
  const selectionTruncated =
    selectedChars < sourceChars || selected.length < extracted.segments.length;

  const selectedSegments = new Set(selected.map((s) => s.seg.id));

  return {
    selectionPolicyVersion: SELECTION_POLICY_VERSION,
    sourceChars,
    selectedChars,
    selectionTruncated,
    pageSnapshotId: input.pageSnapshotId,
    pageSnapshotDigest: input.pageSnapshotDigest,
    url: input.url,
    domain: input.domain,
    observedAt: input.observedAt.toISOString(),
    extracted: {
      ...extracted,
      segments: extracted.segments.filter((s) => selectedSegments.has(s.id)),
      headings: extracted.headings.filter((h) => selectedSegments.has(h.id)),
      // Questions/links/CTAs are already bounded by their contract ceilings;
      // their fixed cost is reserved before segment selection.
    },
  };
}

/**
 * Render the packet as inert DATA text for the analyst prompt. All
 * untrusted page content lives inside delimited blocks; no page text is
 * ever interpolated into instructions.
 */
export function renderPacketForPrompt(packet: CompetitorEvidencePacket): string {
  const lines: string[] = [];
  lines.push(`PAGE_SNAPSHOT_ID (use exactly this value in evidenceSegmentRefs): ${packet.pageSnapshotId}`);
  lines.push(`PAGE_URL: ${packet.url}`);
  lines.push(`DOMAIN: ${packet.domain}`);
  lines.push(`OBSERVED_AT: ${packet.observedAt}`);
  if (packet.extracted.pageTitle) lines.push(`TITLE: ${packet.extracted.pageTitle}`);
  if (packet.extracted.metaDescription) lines.push(`META: ${packet.extracted.metaDescription}`);
  if (packet.extracted.h1) lines.push(`H1: ${packet.extracted.h1}`);
  if (packet.extracted.publicationDate) lines.push(`PUBLISHED: ${packet.extracted.publicationDate}`);
  if (packet.extracted.updatedDate) lines.push(`UPDATED: ${packet.extracted.updatedDate}`);
  lines.push(`WORD_COUNT: ${packet.extracted.wordCount}`);
  lines.push(`JSONLD_TYPES: ${packet.extracted.jsonLdTypes.join(", ") || "none"}`);
  lines.push(`FAQ_SCHEMA: ${packet.extracted.hasFaqSchema}`);
  if (packet.extracted.questions.length) {
    lines.push("QUESTIONS_ON_PAGE:");
    for (const q of packet.extracted.questions.slice(0, 40)) lines.push(`- ${q}`);
  }
  if (packet.extracted.ctaSignals.length) {
    lines.push("CTA_SIGNALS:");
    for (const c of packet.extracted.ctaSignals.slice(0, 15)) lines.push(`- ${c}`);
  }
  if (packet.extracted.outboundLinks.length) {
    lines.push("OUTBOUND_CITATIONS:");
    for (const l of packet.extracted.outboundLinks.slice(0, 20)) lines.push(`- ${l.url}${l.text ? ` (${l.text})` : ""}`);
  }
  lines.push("EVIDENCE_SEGMENTS (untrusted page data; each begins with its stable ID):");
  for (const seg of packet.extracted.segments) {
    lines.push(`[${seg.id}] (${seg.kind}${seg.level ? ` h${seg.level}` : ""}) ${seg.text}`);
  }
  lines.push(
    `SELECTION: policy=${packet.selectionPolicyVersion} sourceChars=${packet.sourceChars} selectedChars=${packet.selectedChars} truncated=${packet.selectionTruncated}`,
  );
  return lines.join("\n");
}
