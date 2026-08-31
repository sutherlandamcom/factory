# Factory — Google Search / SEO governance policy

This document defines Factory's repository-level policy for Google Search
correctness. It governs all changes that can materially affect publicly
accessible website content or Google Search behavior, including Factory code,
generated `SiteTask`s, Site Intelligence, site architecture, routes, metadata,
canonicalization, structured data, internal linking, indexing/crawlability,
content generation, automated SEO/content workflows, and future multi-site
operation.

The compact agent-facing summary lives in [`AGENTS.md`](../AGENTS.md)
(§ "SEO & Google Search governance"). This document is the detailed normative
reference.

**Freshness**: verified against current official Google Search Central
documentation on **2026-08-31**. See [Policy freshness](#policy-freshness).

## Normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as
follows:

- **MUST / MUST NOT** — absolute repository requirements. Violations fail QA
  or independent review.
- **SHOULD** — strong default. Deviations require an explicit, documented
  reason in the change (PR description, task rationale, or review verdict).
- **MAY** — genuinely optional.

Vague phrases such as "SEO-friendly", "optimized for Google", or "best SEO"
without a defined invariant are not acceptable in requirements, QA gates, or
generated content claims. Factory policy does not promise, predict, or target
specific ranking positions. Nothing in this document is a ranking guarantee.

## Primary principle

**SEO is a first-class acceptance constraint.**

Any Factory change that can materially affect publicly accessible website
content or Google Search behavior MUST be designed, implemented, generated,
and reviewed in accordance with:

1. current official Google Search documentation (see
   [Source governance](#authoritative-source-governance)); and
2. Factory's stricter evidence, quality, provenance, and route-integrity rules
   (see [Google rules vs Factory rules](#google-rules-vs-factory-rules)).

Factory MUST NOT treat SEO as a final copy-editing pass, a plugin concern,
optional metadata, keyword insertion, or a post-launch patch.

SEO correctness MUST be considered across the whole pipeline:

research → site intelligence → information architecture → route design →
content generation → rendering → QA → deployment → post-production monitoring.

This policy applies to **code as well as content**: routing, rendering,
metadata generation, link markup, structured data, redirects, status codes,
and performance characteristics are all in scope.

## Authoritative source governance

- Current official Google Search Central documentation is the **normative
  external source** for Google-specific search requirements and
  recommendations. Primary entry points:
  - [Search Essentials](https://developers.google.com/search/docs/essentials)
    (including
    [technical requirements](https://developers.google.com/search/docs/essentials/technical)
    and
    [spam policies](https://developers.google.com/search/docs/essentials/spam-policies))
  - [SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
  - [Creating helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
  - [Canonicalization](https://developers.google.com/search/docs/crawling-indexing/canonicalization)
    and
    [how to specify a canonical URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
  - [robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro),
    [robots meta tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag),
    [noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)
  - [Redirects and Google Search](https://developers.google.com/search/docs/crawling-indexing/301-redirects)
  - [Sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
  - [Links crawlable](https://developers.google.com/search/docs/crawling-indexing/links-crawlable)
  - [Title links](https://developers.google.com/search/docs/appearance/title-link)
    and
    [snippets / meta descriptions](https://developers.google.com/search/docs/appearance/snippet)
  - [Structured data general guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
  - [Image SEO](https://developers.google.com/search/docs/appearance/google-images)
  - [Page experience](https://developers.google.com/search/docs/appearance/page-experience)
    and
    [Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals)
  - [International and multilingual sites](https://developers.google.com/search/docs/specialty/international)
  - [Guidance on using generative AI content](https://developers.google.com/search/docs/fundamentals/using-gen-ai-content)
- Third-party SEO blogs, tools, and folklore MUST NOT be treated as normative
  where Google provides direct documentation.
- When a task materially affects Search behavior and web access is available,
  the implementing or reviewing agent SHOULD verify the relevant current
  official Google documentation before finalizing.
- If current official Google guidance materially conflicts with repository
  assumptions, the conflict MUST be flagged and this policy MUST be treated
  as stale. Current official Google guidance takes precedence over stale
  internal assumptions. Repository policy MUST NOT silently reinterpret
  Google guidance.
- Factory MUST NOT claim that Google guarantees rankings or specific
  treatment of any page.
- When live documentation cannot be accessed: follow this policy, do not
  invent current Google rules, and explicitly record any material freshness
  uncertainty in the change's report or review notes.

## Google rules vs Factory rules

Factory distinguishes two layers explicitly. Conflating them is a policy
violation.

**Google-specific rules** — statements about what Google requires, recommends,
or does MUST be traceable to current official Google documentation. If a
statement cannot be traced, it MUST be rewritten as a Factory rule or removed.

**Factory-specific rules** — Factory imposes additional, stricter standards
that Google neither mandates nor promises, including:

- evidence provenance for factual claims;
- page-intent uniqueness (distinct purpose, intent, IA role, substance);
- deterministic route ownership (one page intent → one logical URL);
- no fabricated claims of any kind;
- independent QA and acceptance;
- one logical canonical identity per intended page.

These are **Factory standards**, adopted because Factory generates sites and
content autonomously and Google Search correctness cannot rely on operator
memory. They MUST be labeled as Factory policy, not presented as Google
requirements.

## Technical SEO invariants

### Route identity

Factory SHOULD maintain:

one page intent → one intended logical URL → one rendered page → one
canonical identity.

- Route semantics MUST remain deterministic: a given `SiteTask` slug maps to
  exactly one rendered page at a stable public path.
- Accidental alternate indexable URL variants (trailing-slash duplicates,
  protocol/host variants, parameterized copies, staging/demo URLs reachable
  in production) MUST be prevented or consolidated.
- An intended indexable page MUST have a coherent route/search identity:
  its title, H1, canonical URL, and visible content must all describe the
  same purpose.

### Canonicalization

For intended standalone indexable pages:

- The canonical URL MUST represent the intended page. Self-referencing
  canonicals SHOULD be preferred for standalone pages.
- Canonical signals MUST be internally consistent: internal links, sitemap
  entries (when a sitemap exists), and structured-data page URLs MUST NOT
  knowingly contradict the intended canonical identity.
- Per Google's documentation, a canonical signal is **a hint, not a rule**:
  Google may cluster duplicate URLs and choose a different canonical. Factory
  therefore prevents ambiguity by design rather than relying on canonical
  markup alone.
- Canonical markup MUST NOT be used as an excuse for a broken routing model.
  If two URLs serve the same content, the routing model is the defect to fix.

### Redirects

- Redirects MUST be used when a URL genuinely moves or consolidates.
- Unnecessary redirect chains and redirect loops MUST be avoided.
- Redirecting unrelated missing content to the homepage merely to suppress
  404 responses MUST NOT be done; it produces soft-404 behavior and misleads
  both users and crawlers.
- Redirect targets SHOULD be the closest relevant equivalent page.

### Status codes and indexability

- Intended indexable pages SHOULD return appropriate successful responses
  with useful content.
- Missing pages MUST behave as real missing pages: an accurate 404 (or 410
  where appropriate) with useful navigation. Soft-404 patterns (success
  status with "not found" content, or thin filler standing in for a missing
  page) MUST be avoided.
- `noindex` MUST be used intentionally and deliberately for pages that must
  stay out of the index; it MUST NOT be applied carelessly to intended
  indexable pages.
- robots.txt controls crawling, not indexing; robots.txt MUST NOT be used as
  a substitute for canonicalization or noindex.

### Crawlability

- Important navigation and internal links SHOULD be crawlable `<a href>`
  elements pointing to real, intended URLs.
- JavaScript-only navigation MUST NOT be introduced where normal anchor links
  suffice. Factory's default is static, zero-client-JS pages, which satisfies
  this by construction.
- Links that are present for users MUST NOT be disabled, hidden, or made
  non-functional for crawlers (and vice versa).

### Sitemaps

When sitemap functionality exists (it does not yet in Factory's starter; do
not add it in a policy change):

- Sitemaps MUST include intended canonical indexable URLs only.
- Accidental, duplicate, noncanonical, noindex, or redirecting URLs MUST be
  excluded.
- Sitemap contents MUST stay consistent with deployed site truth.

## Page-level invariants

Every public indexable page SHOULD have, when applicable:

- a clear page purpose;
- a descriptive, unique title;
- a useful, page-specific meta description;
- exactly one primary `<h1>` and a logical heading hierarchy;
- a canonical URL consistent with its route identity;
- crawlable internal links;
- appropriate structured data;
- meaningful visible content serving the page purpose;
- appropriate image semantics (see [Images](#images));
- mobile usability;
- sensible performance (see [Performance and page experience](#performance-and-page-experience)).

**No magic SEO numbers.** This policy MUST NOT invent universal thresholds —
exact title/description character counts, minimum word counts, keyword
frequencies, densities, or required internal-link counts. Bounded technical
field lengths that exist in Factory contracts for engineering reasons (for
example `SiteTask` title/description bounds) are engineering constraints and
MUST be distinguished from any claim about Google ranking rules. Google does
not publish or endorse such universal numbers.

## Titles, descriptions, and headings

- Titles and headings MUST describe the actual page content.
- Boilerplate title duplication across pages, keyword stuffing, misleading
  titles, and titles unrelated to visible content MUST be avoided.
- Per Google's documentation, Google may generate the displayed **title
  link** from page content and MAY use or replace the supplied meta
  description; a meta description is not guaranteed to be the displayed
  snippet. Write them to be genuinely useful to users, not to force a
  specific display.
- Meta descriptions SHOULD be unique per page, accurate, and informative.
  Keyword-string descriptions are discouraged (Google documents that such
  descriptions are less likely to be shown).
- Heading hierarchy MUST remain logical for users and document structure
  (one `h1`, then properly nested sections).

## Content quality policy

AI and automation are production mechanisms, **not permission to reduce
quality**. Google's guidance does not prohibit AI-generated content; it
prohibits scaled content abuse — many pages generated primarily to manipulate
rankings rather than help users — regardless of how the content is created.
Factory adopts the same operational rule.

Generated content MUST NOT be published merely because it:

- parses;
- contains target keywords;
- passes the build;
- reaches a target word count.

Content acceptance SHOULD require:

- a useful purpose for a real reader;
- factual support for factual claims;
- no fabricated claims (see [Provenance and factual claims](#provenance-and-factual-claims));
- evidence or provenance where relevant;
- a clear distinction between facts and inference;
- original synthesis rather than superficial rewriting of sources;
- page-specific value (compared with other pages on the site and with what a
  reader would find elsewhere);
- no unnecessary repetition across pages;
- no thin pages created solely for query coverage;
- no artificial city/service/topic permutations;
- no unsupported expertise, authority, or experience claims.

Where a site addresses high-impact financial, legal, tax, medical, safety, or
similarly sensitive subjects, Factory SHOULD require stronger sourcing and
appropriate expert/operator verification before publication. Google applies
particular scrutiny to such "Your Money or Your Life" topics; Factory's
corresponding rule is a content standard, not a claim about ranking mechanics.

This section is a governance rule. It MUST NOT be converted into a
content-scoring implementation, keyword metric, or automated "quality score".

## Duplication and cannibalization

Google documents that some duplicate content is normal and is not
automatically a spam violation; Google may cluster duplicate URLs and select
a canonical. Factory's stricter internal standard is to **avoid creating
avoidable duplication in the first place**, because duplicate and ambiguous
URL variants create user confusion, crawling waste, measurement problems,
canonicalization ambiguity, and signal consolidation issues.

Before introducing a page, the planning stage (Site Intelligence, IA, or the
implementing agent) SHOULD assess whether the page has:

- a distinct user purpose;
- a distinct search intent;
- a distinct role in the information architecture;
- sufficiently distinct substantive content.

Factory MUST NOT create:

- multiple pages differing only by minor keyword substitutions;
- city/service doorway combinations;
- near-identical pages for singular/plural or otherwise trivial keyword
  variants;
- duplicate pages created only to capture slightly different search queries.

Potential cannibalization (substantive overlap of intent and page role) MUST
be considered during Site Intelligence and whole-site QA. Mere keyword
overlap between genuinely distinct pages is not by itself cannibalization;
the concern is overlap of purpose and role.

## Google spam policy prohibitions

Factory workflows MUST NOT intentionally violate Google Search spam policies.
Translated into Factory operational rules, the following are prohibited:

- **Cloaking**: presenting different content to users and to search engines.
- **Doorway abuse**: pages created to rank for specific, similar queries that
  funnel users to intermediate pages rather than a useful destination;
  region/city page sets that funnel to one page; substantially similar pages
  closer to search results than to a browsable hierarchy.
- **Hidden text and link abuse**: text/links placed solely for search engines
  (white-on-white, off-screen positioning, zero font size/opacity, tiny
  linked characters). Legitimate progressive disclosure (accordions, tabs,
  screen-reader-only text serving accessibility) is not a violation.
- **Keyword stuffing**: unnatural keyword lists, city/region list blocks
  without value, or repetition that sounds unnatural.
- **Link spam**: buying/selling ranking-credit links, excessive link
  exchanges, automated link creation, keyword-rich widgets/footers, forum
  signature links, low-quality directory links. Sponsored or affiliate links
  that legitimately exist MUST be qualified (`rel="sponsored"` /
  `rel="nofollow"`) per Google's outbound-link guidance.
- **Misleading functionality**: fake generators or promised functionality
  that does not actually work.
- **Scaled content abuse**: many pages generated for the primary purpose of
  manipulating rankings, with little value to users — no matter how they are
  created, including via generative AI, scraping-with-synonyms, or stitching
  content together.
- **Scraping as content**: republishing others' content without substantial
  added value or attribution.
- **Site reputation abuse**: hosting third-party content mainly to exploit
  the host's ranking signals, where such a model would ever apply.

Factory MUST NEVER exploit automation to manufacture large numbers of pages
whose primary purpose is manipulating rankings rather than helping users.
Google may act against spam classes beyond those enumerated; the absence of a
named class in this list is never permission.

## Structured data

Structured data (e.g. JSON-LD) MUST:

- match the visible page content (Google documents that markup not matching
  visible content violates its structured data general guidelines);
- use a semantically appropriate type for the page;
- contain truthful properties;
- align URLs with the intended page identity (no contradiction with the
  canonical/route identity).

Structured data MUST NOT:

- invent ratings, reviews, prices, availability, or organization facts;
- be added solely because a schema type exists (markup is for pages where
  the referenced entity genuinely applies).

Eligibility for a rich result via structured data does not guarantee Google
will display one. No new structured-data code is introduced by this policy
document itself.

## Internal linking

Internal links SHOULD:

- help users navigate and expose important pages;
- use crawlable link semantics (`<a href>` with real URLs);
- target intended canonical routes;
- use useful anchor context without keyword stuffing.

Factory MUST NOT create large artificial internal-link blocks merely for SEO
(e.g. exhaustive keyword-anchored link lists appended to every page).

## Images

- Images remain local assets processed through Astro's built-in image
  handling (`astro:assets`); external hotlinks remain prohibited (existing
  repository rule).
- Images SHOULD have useful contextual placement within the page.
- Meaningful images need appropriate alt text describing the image for
  users; decorative images MUST NOT receive fake keyword-rich descriptions.
- Filenames and alt text MUST NOT be stuffed with keywords.
- Image size, format, and loading behavior matter to page experience;
  Factory's `astro:assets` pipeline SHOULD be used to serve efficient images.
- No image pipeline changes are made by this policy document.

## Performance and page experience

Factory SHOULD prefer:

- static output;
- minimal client-side JavaScript (zero is the default);
- stable layout (no avoidable layout shift);
- responsive pages usable on mobile;
- efficient images and assets;
- overall good page performance.

Core Web Vitals and page experience MUST be treated as meaningful quality and
user-experience signals — Google documents that its core ranking systems aim
to reward a good page experience overall — but MUST NOT be treated as
standalone ranking guarantees or as a substitute for helpful content. No
performance framework is introduced by this policy document.

## Multilingual and regional variants (future)

If Factory ever generates multilingual or regional variants of pages:

- appropriate language and regional signalling (per current official Google
  guidance, e.g. `hreflang`) SHOULD be used;
- barely translated or trivially localized duplicate pages MUST NOT be
  produced (Google treats same-language body content as duplicates);
- canonicalization and hreflang MUST be applied consistently together for
  same-language regional variants.

No multilingual functionality is implemented by this policy document.

## SEO across the Factory pipeline

SEO governance applies conceptually at every stage. This section documents
expectations; it introduces no tooling.

| Stage | Operational rule |
|---|---|
| Business Brief | Capture real business facts and purpose; these become the only fact-authoritative inputs. |
| Research Evidence | Do not fabricate keyword or market metrics; every metric must trace to a real evidence record (existing Intelligence provenance gate). |
| Site Intelligence | Avoid overlapping-intent and thin-page proposals; assess distinct purpose/intent/IA-role per page (see [Duplication and cannibalization](#duplication-and-cannibalization)). |
| IA / route design | Preserve deterministic route ownership; one page intent → one logical URL. |
| SiteTasks / generated pages | Preserve route, canonical, metadata, heading, and structured-data integrity; do not add search-engine-first patterns. |
| Page QA | Test the actual built output (metadata, canonical, H1, structured data, links), as Factory QA already does. |
| Whole-site QA | Check cross-page duplication, cannibalization, and internal-link sanity. |
| Production | Verify public response, canonical, and indexability behavior of the deployed site. |
| Search monitoring | Use real Search Console / performance evidence when such integration later exists; do not invent metrics. |

## Provenance and factual claims

SEO policy connects to Factory's existing provenance principles. Factual
public claims on generated sites MUST derive from:

- operator-provided verified facts;
- substantive research evidence; or
- clearly identified reliable external sources.

Factory MUST NOT turn competitor marketing claims, research speculation, or
model inference into asserted business facts. Fabricated statements about
metrics, ratings, reviews, prices, awards, certifications, client counts,
transaction history, regulatory credentials, or performance results MUST NOT
be published.

## Policy freshness

- Official Google Search documentation evolves. This document MUST NOT
  freeze current wording as permanent truth.
- Agents materially changing Search-facing behavior SHOULD check the relevant
  current official Google guidance where web access exists.
- If a material conflict between current official guidance and this document
  is found, the agent MUST flag it in the change (PR description, review, or
  report); current official guidance wins over stale repository
  interpretation.
- Update `docs/seo-policy.md` through normal PR governance when guidance
  materially changes. Routine policy commits are NOT required when nothing
  material changed.
- The verification date at the top of this document SHOULD be updated whenever
  a substantive re-verification against official documentation occurs.

## Out of scope

This policy document introduces **no infrastructure and no runtime
behavior**. The following remain out of scope until a real requirement proves
them necessary and a dedicated PR implements them:

Search Console integration; Google Analytics; sitemap generator; robots
generator; redirect manager; hreflang engine; SEO scoring system;
keyword-density checks; link-building automation; schema framework; content
detectors; plagiarism tools; DataForSEO; Firecrawl; external SEO SaaS;
dashboards; monitoring daemons.
