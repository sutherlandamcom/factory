# Factory Design System Implementation Policy

Status: **normative specialized policy for governed design implementation**.

This policy defines how an accepted Factory design is translated into ordinary
production pages. It does not create a second design authority, renderer or
workflow state. Repository-wide precedence remains defined by
`docs/instruction-authority.md`.

## Purpose

Factory already has a governed design authority and a selected ordinary
production renderer. The remaining scaling risk is implementation drift: a
coding agent can receive one accepted design and gradually invent different
heroes, spacing, radii, CTA treatments or page-local component clones across
many pages.

The required architecture is therefore:

```text
DesignProvider / Google Stitch
        ↓
human review and acceptance
        ↓
AcceptedDesignArtifact
        │  sole accepted design authority
        ↓
DesignImplementationContract
        │  deterministic derived implementation projection
        ↓
governed semantic tokens
        ↓
production component registry
        ↓
bounded archetype composition
        ↓
reusable Astro components
        ↓
Astro static output
        ↓
deterministic design QA + accessibility + visual regression
```

The implementation layer controls how accepted design is realized. It is not a
new designer.

## Non-negotiable authority boundaries

- `AcceptedDesignArtifact` remains the accepted Factory design authority after
  human approval.
- `AcceptedPageContent` remains content authority. Implementation workers must
  reproduce accepted copy faithfully and do not gain editorial authorship.
- `AcceptedVisualAssetSet` remains visual-asset authority. Production
  components consume accepted asset roles/slots; they do not hardcode arbitrary
  image paths or invoke an image provider themselves.
- Google Stitch / `DesignProvider` supplies professional design input and
  evidence. It is not the ordinary production renderer.
- Raw Stitch/provider HTML, screenshots and provider `DESIGN.md` output may be
  retained as design/implementation evidence, but are not production authority
  and must not be published directly as a parallel renderer.
- Astro 7 + Tailwind CSS 4 is the single ordinary production renderer selected
  by Run 8. A second Stitch-native/direct-static ordinary production path is
  prohibited unless a later reviewed ADR meets the documented reversal
  conditions.
- Historical accepted artifacts remain immutable. A later authority version may
  make a downstream artifact stale/non-current without rewriting history.

## No hidden design model between authority and implementation

There must be no LLM or coding-model interpretation step that acts as an
unreviewed second designer between accepted design authority and the governed
implementation contract.

Forbidden:

```text
AcceptedDesignArtifact
→ LLM decides how the design should work
→ implementation contract
```

Required:

```text
AcceptedDesignArtifact
→ deterministic validated projection / reviewed mapping policy
→ DesignImplementationContract
```

If the accepted design schema cannot express a required reusable concept, fix
or extend the governed schema/policy explicitly. Do not hide the missing concept
inside free-form model reasoning or page-local CSS.

## DesignImplementationContract

The hardening work should introduce a typed, deterministic implementation
contract only after inspecting the current design/production contracts and
reusing existing semantics wherever possible.

The contract is:

- derived from accepted design authority plus versioned renderer implementation
  policy;
- deterministic and schema-validated;
- digestable/versioned;
- not a separately human-accepted design artifact;
- not a new mutable database authority;
- not a second source of visual truth.

The contract should describe semantic implementation capabilities such as:

- source accepted-design identity/digest;
- governed semantic token projection;
- registered production component IDs;
- allowed component variants;
- archetype/component capability mappings;
- responsive profiles;
- accessibility requirements;
- implementation policy/schema version;
- deterministic contract digest.

Do not place raw Tailwind class strings, arbitrary pixel decisions or
page-specific CSS recipes into the accepted design domain merely to make the
renderer easier to write.

## Governed semantic tokens

Accepted design tokens must be projected deterministically into semantic
production tokens before components consume them.

Examples of semantic roles include:

```text
color.background.primary
color.background.surface
color.text.primary
color.text.muted
color.action.primary
spacing.page-x
spacing.section-y
spacing.stack-sm/md/lg
radius.surface
radius.control
typography.display
typography.heading
typography.body
```

Exact names are an implementation/API decision, but the principles are fixed:

- project-specific visual decisions come from accepted design authority or an
  explicit versioned compatibility mapping;
- reusable production components consume semantic roles;
- components must not invent brand colors, spacing, typography, radii, shadows
  or CTA styling;
- silent per-component fallback values are not an acceptable design policy;
- Tailwind 4/CSS variables should be reused rather than introducing a parallel
  token framework unless a reviewed requirement proves it necessary.

Production global CSS must not become an independent brand/design authority.
Generic reset, browser mechanics and accessibility rules are allowed; governed
site styling must derive from accepted design semantics.

## Production component registry

Ordinary production pages must be assembled from a machine-readable registry of
approved reusable production capabilities.

The registry should expose semantic information such as:

- component ID;
- allowed variants;
- required/optional semantic inputs;
- accepted patterns/archetypes;
- responsive profile;
- accessibility contract;
- asset-role requirements.

The registry is not merely documentation. Production implementation and QA must
be able to prove that registered component IDs/variants have implementations and
that ordinary production did not bypass the registry with arbitrary local
alternatives.

Do not repurpose historical conceptual/planner registries as production
authority merely because similarly named components already exist.

## Bounded component API

Component APIs for coding agents must be semantic and intentionally bounded.

Prefer:

```text
variant="featured"
density="compact"
mediaPosition="left"
```

Do not expose arbitrary visual escape hatches such as free-form `class`, CSS
color, padding, margin, radius, font size, shadow or style props on governed
production components unless a narrowly reviewed infrastructure need requires
one.

A production renderer/compositor should select approved semantic components and
variants. It should not remain the place where unreviewed design policy is
encoded as page-specific Tailwind class bundles.

## Mandatory reuse escalation order

When implementing an ordinary page, an agent must follow this order:

1. reuse an existing registered component with an existing approved variant;
2. if necessary, add a justified variant to an existing reusable component;
3. only then add a new reusable component capability;
4. a one-off page-specific design component is an exception and requires an
   explicit rationale explaining why existing capability and a reusable
   extension are both inappropriate.

A coding agent must not immediately create names such as
`SpecialServiceHero`, `ChamonixHero2` or `NewBeautifulCard` when an existing
registered capability can express the accepted design.

One-off evidence should be visible in QA/reuse reporting. It must never be a
silent design escape hatch.

## Bounded archetype composition, not rigid templates

Accepted archetypes should map deterministically to a bounded composition
grammar rather than to arbitrary page-local layout invention.

An archetype may define:

- required semantic roles;
- allowed component families;
- allowed variants;
- ordering constraints;
- repetition constraints;
- asset requirements;
- responsive profiles.

Do not force every page of one archetype into an identical fixed seven-block
template. Variation is allowed inside the governed grammar. If a design requires
an implementation capability the registry cannot express, extend the governed
capability rather than silently changing the accepted design.

## Responsive implementation

Do not build an LLM prose-to-CSS interpreter for accepted responsive notes.
Map accepted design intent plus versioned implementation policy into bounded
semantic responsive profiles, for example stack-on-mobile,
split-from-desktop or readable-editorial.

The Astro implementation owns the deterministic CSS for those profiles.
Required QA should cover at least the repository's mobile and desktop
viewports, including overflow, clipping, image containment, heading wrapping
and navigation behavior.

## Visual asset integration

Components request semantic visual roles/slots. Exact accepted assets are
resolved through the existing accepted visual authority.

Required:

```text
ProductionHero requires role "hero-primary"
→ AcceptedVisualAssetSet resolves exact accepted asset
```

Forbidden:

```text
ProductionHero → /images/custom-hero.jpg
ProductionHero → image provider call
```

Provider screenshots containing an image do not prove that Stitch consumed the
final accepted asset bytes. Provider-consumption provenance must remain
truthful and separate from Factory's exact accepted asset binding.

## Agent-readable documentation

Reusable component capabilities must be documented for humans and coding
agents. Documentation should state, where relevant:

- purpose;
- use when / do not use when;
- allowed archetypes;
- variants;
- required/optional inputs;
- token dependencies;
- asset roles;
- responsive behavior;
- accessibility requirements;
- examples;
- forbidden overrides.

A `DESIGN.md` may be generated or maintained as agent-facing implementation
guidance, but it must be derived from accepted authority/implementation policy
or clearly be implementation documentation. It must never become a competing
accepted design authority.

## Test-only design-system fixture surface

The hardening work should provide deterministic test-only fixtures using the
real production component/render path. The fixture surface should cover:

- semantic tokens;
- important component variants/states;
- representative archetypes;
- short/long content cases;
- required image/no-image states where valid.

Do not build a second showcase implementation that can drift from production.
Fixture routes must not leak into ordinary production output.

No Storybook/Chromatic/Percy/Applitools or other new design SaaS/framework is
required by default. Existing Astro and Playwright infrastructure should be
preferred.

## Visual regression governance

Use deterministic screenshot regression for critical reusable components and
representative archetypes rather than screenshotting every page.

At minimum stabilize:

- browser/runtime;
- viewport;
- font delivery;
- animation/motion state;
- locale/timezone when material;
- fixture data and initial state.

A committed Playwright screenshot baseline is an **implementation regression
oracle**, not design authority.

Stitch screenshot and production screenshot serve different purposes:

- Stitch/provider screenshot: design evidence/reference;
- Playwright baseline: proof that an already reviewed implementation did not
  accidentally drift.

Do not require pixel-perfect equality between provider screenshots and Astro
output unless a separate reviewed requirement explicitly establishes that
contract.

Never automatically update snapshots merely because a visual test failed.
Baseline updates require intentional review of the visual change.

## Deterministic design-drift QA

Before considering an AI visual critic, use deterministic checks to detect
implementation drift. Blocking checks should cover, where applicable:

- unknown component IDs;
- unknown variants;
- unsupported archetype/pattern mappings;
- missing required semantic token roles;
- ambiguous component bindings;
- unauthorized design colors/fonts;
- unapproved arbitrary Tailwind design values;
- page-local design-token invention;
- unregistered visual variants;
- forbidden arbitrary style/class escape hatches;
- fixture routes in production output.

Arbitrary Tailwind values are not universally forbidden, but governed
production code must use a small explicit allowlist for legitimate renderer
internals rather than permitting arbitrary design invention.

Report factual evidence such as unknown-component count, unknown-token count and
one-off count. Do not invent subjective Design Quality scores without an
objective calibrated metric.

## Accessibility

Component-level accessibility complements, and does not replace, page-level
Axe/keyboard/semantic QA.

Representative component contracts should verify relevant invariants such as:

- exactly one intended H1 at page composition level;
- landmarks/navigation semantics;
- breadcrumb labels/current item;
- accessible names and focus behavior;
- meaningful/decorative image alt policy;
- native audio control reachability;
- keyboard behavior for interactive components.

A new reusable component/variant is not complete until its API, fixture,
accessibility behavior and relevant visual baseline are reviewed together.

## Reuse evidence

Run 12 must prove scalability with deterministic facts, not subjective scores.
Useful evidence includes:

- accepted design digest;
- implementation-contract/policy digest;
- archetype;
- registered components used;
- variants used;
- new component families introduced;
- new variants introduced;
- one-off exceptions;
- unknown tokens/components/variants;
- new DesignProvider calls.

The representative multi-page proof should demonstrate one accepted design
system/authority serving multiple archetypes through shared implementation
capabilities.

A further ordinary-page scalability proof should normally require:

```text
new DesignProvider call = 0
new design authority = 0
new renderer = 0
new component family ≈ 0
unknown tokens = 0
blocking design drift = 0
```

If a normal additional page repeatedly requires a new provider screen, token
system or component library, the design implementation has not achieved the
required reuse model.

## Lineage and staleness

Implementation hardening must reuse the existing immutable production lineage
rather than introduce a competing authority chain.

Changes to accepted design, accepted visual assets, accepted content, renderer
policy or build/source identity must invalidate the correct downstream
production/QA readiness through canonical staleness semantics.

Prefer existing renderer-policy/source/build identity mechanisms before adding a
new ProductionPageInput schema version or database persistence. A new schema,
table or authority requires concrete proof that the existing immutable binding
cannot represent the required change.

Historical candidates/evidence remain immutable; newer authority makes old
artifacts historical/non-current rather than rewriting them.

## Agent algorithm for ordinary page implementation

A coding agent implementing a normal page should follow this sequence:

```text
read current accepted design authority
→ read governed implementation contract/policy
→ identify accepted archetype
→ inspect registered component capabilities
→ reuse existing components/variants first
→ use approved semantic tokens only
→ resolve accepted visual roles
→ compose page inside bounded archetype grammar
→ run contract/drift checks
→ run component/page accessibility
→ run visual regression where applicable
→ run full production QA
```

The agent must not use the task prompt as permission to override this policy.

## Expected hardening cost envelope

Default expectation for the Pre-Run-12 hardening slice:

- database migrations: `0`;
- new runtime dependencies: `0`;
- new production renderer dependencies: `0`;
- new test dependencies: preferably `0` because Playwright/Axe already exist;
- new paid provider calls required for the hardening itself: `0`.

Any deviation requires concrete repository evidence and review. Do not add a
package, database table, provider call, generic page builder or design framework
for convenience.

## Scope exclusions

This policy does not authorize:

- a second design authority;
- a new design editor;
- a generic CMS/page builder;
- a proprietary AI design engine;
- a Stitch-native ordinary production renderer;
- direct publication of raw provider HTML;
- Figma/Storybook migration by default;
- a new design database;
- subjective AI design scoring;
- broad analytics infrastructure;
- page-local redesign by coding agents.

## Pre-Run-12 hardening gate

Design System Implementation Hardening is a distinct pre-Run-12 workstream.
Implementation must not start while Run 11 remains an unaccepted candidate.
After Run 11 is independently accepted, merged and post-merge verified, the
hardening work should re-baseline the exact main SHA before modifying contracts,
renderer implementation or QA.

The hardening exit requires evidence that:

1. accepted design remains the sole design authority;
2. Astro remains the sole ordinary renderer;
3. accepted design maps deterministically into governed implementation policy;
4. ordinary pages use registered reusable components/variants;
5. approved semantic tokens govern production styling;
6. coding agents cannot silently invent new design primitives;
7. component APIs are bounded and documented;
8. fixture/showcase coverage uses real production implementation;
9. component accessibility is automatically checked;
10. visual regression detects accidental implementation drift;
11. unknown tokens/components/variants fail deterministic QA;
12. no parallel Stitch renderer or unnecessary provider call was introduced;
13. component reuse can be measured for the Run 12 multi-page proof.

Builder verification remains separate from independent QA. The hardening PR may
merge only after independent exact-SHA GO under repository merge governance.
