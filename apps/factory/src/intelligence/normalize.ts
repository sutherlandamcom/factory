import {
  normalizedResearchEvidenceBundleSchema,
  type NormalizedResearchEvidenceBundle,
  type NormalizedResearchEvidenceItem,
  type ResearchEvidenceBundle,
} from "@factory/contracts";

/**
 * Non-destructive research normalization.
 *
 * Guarantees:
 * - Every original evidence record is preserved verbatim: ids, sourceUrl,
 *   text, metrics, and every other validated field are never rewritten.
 * - Records may only GAIN two provenance helpers: `normalizedUrl` (a
 *   conservative comparison form of sourceUrl) and `duplicateOf` (a marker
 *   referencing an existing original evidence id when the normalized URL of
 *   two records is identical).
 * - No evidence is discarded, merged away, or semantically rewritten.
 * - Records are stable-sorted by evidence id, because the source array order
 *   carries no meaning; this makes the normalized representation (and its
 *   digest) independent of input ordering.
 */

/**
 * Conservative URL comparison form: lowercase scheme + hostname, default
 * ports removed (http:80 / https:443), and the root path "/" collapsed to
 * empty (the trivial trailing root slash). Query strings, fragments, path
 * segments, credentials, and everything else are preserved verbatim.
 * `sourceUrl` itself is never replaced — this form is additive only.
 */
export function normalizeUrlForComparison(rawUrl: string): string {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  const isDefaultPort =
    (url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443");
  const port = isDefaultPort ? "" : url.port === "" ? "" : `:${url.port}`;
  const auth = url.username || url.password ? `${url.username}:${url.password}@` : "";
  const pathname = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${auth}${host}${port}${pathname}${url.search}${url.hash}`;
}

export function normalizeResearchBundle(bundle: ResearchEvidenceBundle): NormalizedResearchEvidenceBundle {
  const sortedItems = [...bundle.items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const firstIdByNormalizedUrl = new Map<string, string>();
  const items: NormalizedResearchEvidenceItem[] = sortedItems.map((item) => {
    const normalized: NormalizedResearchEvidenceItem = { ...item };
    if (item.sourceUrl !== undefined) {
      normalized.normalizedUrl = normalizeUrlForComparison(item.sourceUrl);
      const earliestId = firstIdByNormalizedUrl.get(normalized.normalizedUrl);
      if (earliestId !== undefined && earliestId !== item.id) {
        // Likely duplicate: keep both records, mark provenance only.
        normalized.duplicateOf = earliestId;
      } else {
        firstIdByNormalizedUrl.set(normalized.normalizedUrl, item.id);
      }
    }
    return normalized;
  });

  const result = {
    version: bundle.version,
    collectedAt: bundle.collectedAt,
    items,
  };
  // Defensive self-check: normalization output must always satisfy the
  // normalized bundle contract (duplicateOf resolves, no chains, no dups).
  return normalizedResearchEvidenceBundleSchema.parse(result);
}

export function countDuplicateEvidenceRecords(bundle: NormalizedResearchEvidenceBundle): number {
  return bundle.items.reduce((count, item) => (item.duplicateOf !== undefined ? count + 1 : count), 0);
}
