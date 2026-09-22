import type { DesignArchetypeKind } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";

/**
 * PAGE-ARCHETYPE DERIVATION POLICY — deterministic slug-pattern helper.
 *
 * Bounded role: this regex policy is a PLANNING PROPOSAL / LEGACY design-v1
 * COMPATIBILITY classification helper. It deterministically proposes a
 * page→archetype mapping for fixtures, tests, and historical design-v1
 * classification paths.
 *
 * It is NOT production runtime authority for design-v2. The hardened
 * design-v2 authority chain is:
 *
 *   explicit planning / classification
 *     → PageArchetypeStore (setPageArchetype)
 *     → durable PageArchetypeAuthority
 *     → DesignInputSnapshot records exact authority
 *     → ProductionPageInput binds exact authority
 *     → ProductionStore verifies current authority
 *
 * Legacy invariants (unchanged):
 * - deterministic: same slug -> same archetype, always;
 * - fail-closed: unclassified (no pattern match), ambiguous (multiple
 *   disjoint patterns match) and unsupported (derived kind is not supported
 *   by the accepted design) are typed errors, never silent fallbacks;
 * - independent of representative-page selection;
 * - inspectable: the policy version is recorded wherever the helper is
 *   consumed so auditors can see which legacy policy classified a page.
 */

export const PAGE_ARCHETYPE_POLICY_VERSION = "page-archetype-policy-v1" as const;

/**
 * Disjoint slug patterns per archetype. Order matters only for error
 * reporting; ambiguity is detected by counting matches, never by picking
 * a winner.
 */
const ARCHETYPE_PATTERNS: ReadonlyArray<{ kind: DesignArchetypeKind; pattern: RegExp }> = Object.freeze([
  { kind: "homepage", pattern: /^(|\/|home|homepage|index)$/ },
  { kind: "service", pattern: /(^|\/)(services?|solutions?|offerings?|advisory|consulting)(\/|$)/ },
  { kind: "location", pattern: /(^|\/)(locations?|areas?|regions?|contact)(\/|$)/ },
  { kind: "editorial", pattern: /(^|\/)(research|insights?|articles?|blog|editorial|journal)(\/|$)/ },
  { kind: "investment_advisory", pattern: /(^|\/)(investment|investing|capital-allocation|portfolio-strategy)(\/|$)/ },
]);

/** Typed failure codes for page-archetype derivation. */
export type PageArchetypeErrorCode =
  | "page_archetype_unclassified"
  | "page_archetype_ambiguous"
  | "page_archetype_unsupported";

export class PageArchetypeError extends FactoryError {
  constructor(code: PageArchetypeErrorCode, message: string) {
    super(code, message);
  }
}

export interface DerivedPageArchetype {
  slug: string;
  archetype: DesignArchetypeKind;
  policyVersion: typeof PAGE_ARCHETYPE_POLICY_VERSION;
}

/**
 * Legacy/planning slug-pattern classification for one page slug against the
 * archetype kinds the accepted design supports. NOT design-v2 runtime
 * authority — see the module docblock for the hardened authority chain.
 * Fails closed on:
 * - unclassified: no pattern matches (a new page kind needs either a policy
 *   revision or a new accepted design archetype — never a silent default);
 * - ambiguous: multiple disjoint patterns match;
 * - unsupported: the derived kind exists but the accepted design does not
 *   support it (a new archetype requires new design authority).
 */
export function derivePageArchetype(
  slug: string,
  supportedKinds: ReadonlyArray<DesignArchetypeKind>,
): DerivedPageArchetype {
  const normalized = slug.trim().toLowerCase();
  const matches = ARCHETYPE_PATTERNS.filter((entry) => entry.pattern.test(normalized)).map((entry) => entry.kind);
  if (matches.length === 0) {
    throw new PageArchetypeError(
      "page_archetype_unclassified",
      `Page "${slug}" matches no archetype pattern in ${PAGE_ARCHETYPE_POLICY_VERSION}; classification is BLOCKED until the page-archetype policy or the accepted design authority covers it.`,
    );
  }
  if (matches.length > 1) {
    throw new PageArchetypeError(
      "page_archetype_ambiguous",
      `Page "${slug}" ambiguously matches multiple archetypes (${matches.join(", ")}) in ${PAGE_ARCHETYPE_POLICY_VERSION}; classification is BLOCKED.`,
    );
  }
  const archetype = matches[0]!;
  if (!supportedKinds.includes(archetype)) {
    throw new PageArchetypeError(
      "page_archetype_unsupported",
      `Page "${slug}" derives archetype "${archetype}" which the accepted design does not support (supported: ${supportedKinds.join(", ")}); production is BLOCKED until appropriate design authority exists.`,
    );
  }
  return { slug: normalized, archetype, policyVersion: PAGE_ARCHETYPE_POLICY_VERSION };
}

/** Legacy/planning batch helper over derivePageArchetype; fails closed on the first violation. */
export function derivePageArchetypes(
  slugs: ReadonlyArray<string>,
  supportedKinds: ReadonlyArray<DesignArchetypeKind>,
): DerivedPageArchetype[] {
  return slugs.map((slug) => derivePageArchetype(slug, supportedKinds));
}
