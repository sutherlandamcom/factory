# E2E-01 governed component API review

Reviewed before Astro changes against the accepted implementation policy.

`page-cta` retains its existing text-first visual variant and governed action token. Add one semantic prop, `destinationHref?: string`, supplied only by the digest-bound conversion authority. Required action renders an anchor with accepted CTA text as its accessible name. Informational authority renders prose. Historical manifests keep their historical text rendering; they do not acquire actionable authority retroactively. No new colors, spacing, layout freedom, assets or component family.

Ruling: action versus informational is authority-driven semantic behavior, not a new visual design variant. The existing text treatment remains unchanged. Keyboard activation and exact href/text are acceptance constraints. Required actions without valid authority fail before rendering and fail content-integrity QA.

Navigation consumes bound SiteProfile entries through the manifest, uses existing spacing/text tokens, wraps on small screens, and exposes a labelled navigation landmark. Every destination must belong to the candidate route set.
