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
        │  sole accepted Factory design authority
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

## Transition status and scope

This policy defines the target constraints for the explicit Pre-Run-12 Design
System Implementation Hardening workstream. Until that hardening implementation
is independently accepted and merged, references here to a
`DesignImplementationContract`, production component registry, governed token
projection or fixture surface describe required target capabilities; they do not
assert that those capabilities already exist on `main`.

Agents working on other workstreams MUST NOT opportunistically implement
this policy ahead of the roadmap gate. They preserve the accepted current
implementation until the explicit hardening slice begins.

This policy also does not expand the write authority of runtime `SiteTask`
workers. `TaskWritePolicy` and the repository-wide `AGENTS.md` runtime write
scope remain authoritative. Registry, token, component or renderer-policy
evolution requires an explicitly authorized repository-engineering task.

## Non-negotiable authority boundaries

- `AcceptedDesignArtifact` remains the accepted Factory design authority after
  human approval.
- Google Stitch / `DesignProvider` owns professional design **generation only**;
  provider output, IDs, HTML, screenshots and `DESIGN.md` are never Factory
  design authority before or after acceptance.
- `AcceptedPageContent` remains content authority. Implementation workers must
  reproduce accepted copy faithfully and do not gain editorial authorship.
- `AcceptedVisualAssetSet` remains visual-asset authority. Production
  components consume accepted asset roles/slots; they do not hardcode arbitrary
  image paths or invoke an image provider themselves.
- Raw Stitch/provider HTML, screenshots and provider `DESIGN.md` output may be
  retained as design/implementation evidence, but are not production authority
  and must not be published directly as a parallel renderer.
- Astro 7 + Tailwind CSS 4 is the single ordinary production renderer selected
  by Run 8. A second Stitch-native/direct-static ordinary production path is
  prohibited unless a later reviewed ADR meets the documented reversal
  conditions.
- Historical accepted artifacts remain immutable. A later authority version may
  make a downstream artifact stale/non-current without rewriting history.

## Required Phase 0 — repository design audit

Before implementing the hardening, re-baseline the exact post-PR44 verified `main` SHA
and inspect the repository as it actually exists. Do not choose new schemas,
files or component architecture from this policy alone.

At minimum inventory:

- current `packages/contracts` design contracts and `AcceptedDesignArtifact`;
- design-provider/Stitch normalization and acceptance path;
- accepted visual-set authority and slot semantics;
- production contracts, including `ProductionPageInput` and renderer identity;
- production render manifest/compiler and candidate lineage;
- current archetype/pattern vocabulary;
- existing production Astro components and layout/compositor seams;
- global/site styling and token surfaces;
- historical/planner component registries that must not become accidental
  production authority;
- Playwright, Axe, keyboard, Lighthouse and production QA surfaces;
- current CI and agent/documentation surfaces.

Phase 0 must produce a concise gap matrix before implementation begins:

```text
Capability | Exists | Partial | Missing | Action
```

Each planned change must map to a concrete observed gap. Existing canonical
mechanisms should be reused instead of duplicated.

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
contract only after the Phase 0 audit has inspected the current design/production
contracts and reused existing semantics wherever possible.

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

## Component API review gate — API first, implementation second

Before adding or materially changing a governed production component, define
and review its semantic API before writing the Astro implementation.

The review must establish:

1. semantic component ID and purpose;
2. minimal approved variants;
3. required and optional semantic props;
4. allowed archetypes/patterns;
5. responsive profile;
6. accessibility contract;
7. accepted visual-asset roles/slots;
8. token dependencies;
9. whether any proposed prop creates unnecessary visual freedom.

Only after this API review may the Astro component, fixture, accessibility test
and visual baseline be implemented. Avoid designing an API retrospectively from
a page-specific Tailwind implementation.

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
prove both directions of integrity:

```text
registered production component IDs == implemented production component IDs
registered variants              == implemented approved variants
```

A registered component/variant without an implementation is invalid. A governed
production implementation that is absent from the registry is also invalid.
Ordinary production must not bypass the registry with arbitrary local
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
implementation drift. Classify findings explicitly.

### BLOCKING

Examples include:

- unknown component IDs;
- unknown variants;
- unsupported archetype/pattern mappings;
- missing required semantic token roles;
- ambiguous component bindings;
- unauthorized design colors/fonts;
- unapproved arbitrary Tailwind design values outside the explicit allowlist;
- page-local design-token invention;
- unregistered visual variants;
- forbidden arbitrary style/class escape hatches;
- registry/implementation mismatch;
- fixture routes in production output;
- accepted-design or implementation-contract identity/digest mismatch.

Blocking findings fail the governed build/QA path.

### REVIEW / WARNING

Examples include:

- a documented one-off component exception;
- a new variant requiring explicit reuse rationale;
- an unusual but allowlisted renderer-internal arbitrary value;
- a deliberate visual baseline change awaiting review.

These require visible rationale/review and must not be silently normalized away.

### INFO

Examples include deterministic evidence such as:

- components and variants used;
- reuse counts;
- new component-family count;
- one-off count;
- unknown-token/component/variant count when zero.

Arbitrary Tailwind values are not universally forbidden, but governed
production code must use a small explicit allowlist for legitimate renderer
internals rather than permitting arbitrary design invention.

Report factual evidence. Do not invent subjective Design Quality scores without
an objective calibrated metric.

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
- new DesignProvider calls;
- coding-model design-invention calls/steps.

The representative multi-page proof should demonstrate one accepted design
system/authority serving multiple archetypes through shared implementation
capabilities.

A further ordinary-page scalability proof should normally require:

```text
new DesignProvider call = 0
new design authority = 0
new renderer = 0
new component family ≈ 0
coding-model design invention = 0
unknown tokens = 0
blocking design drift = 0
```

If a normal additional page repeatedly requires a new provider screen, token
system, component library or free-form coding-model design decision, the design
implementation has not achieved the required reuse model.

## Lineage and staleness

Implementation hardening must reuse the existing immutable production lineage
rather than introduce a competing authority chain.

The current production contract already binds renderer identity as:

```text
renderer.id
renderer.version
renderer.policyVersion
```

Therefore an implementation-policy change should first be represented through
the existing `renderer.policyVersion` staleness mechanism. Do not introduce
`ProductionPageInput v3` merely to version the
`DesignImplementationContract`.

The exact `DesignImplementationContract` digest must also be carried in durable
production build/render evidence (for example the trusted render manifest and
its digest lineage) so an auditor can prove which exact contract materialized a
candidate. This digest is evidence/binding, not a second accepted authority or
new mutable DB state. Add a ProductionPageInput schema version only if Phase 0
proves the existing immutable bindings cannot represent the required lineage.

Changes to accepted design, accepted visual assets, accepted content, renderer
policy or build/source identity must invalidate the correct downstream
production/QA readiness through canonical staleness semantics.

Historical candidates/evidence remain immutable; newer authority makes old
artifacts historical/non-current rather than rewriting them.

Required mutation coverage includes at least:

- accepted design changes;
- accepted visual set changes;
- accepted content changes;
- renderer policy version changes;
- source/repository build identity changes.

## Agent algorithm for ordinary page implementation

A coding agent implementing a normal page should follow this sequence after the
hardening capability exists on accepted `main`:

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
- page-local redesign by coding agents;
- broader runtime `SiteTask` write permissions.

## Pre-Run-12 hardening gate

Design System Implementation Hardening is a distinct pre-Run-12 workstream.
Run 11 is closed (implemented, independently QA'd, merged and post-merge verified).
Implementation of hardening must not start until this governance policy (PR #44)
passes independent exact-SHA QA, merges and passes post-merge verification on main.
After PR #44 has passed independent exact-SHA QA, merged, and passed post-merge
verification, the implementation agent MUST fetch the live repository state,
record the then-current verified `main` SHA (the post-PR44 `main` SHA), and perform
the mandatory Phase 0 gap matrix against that exact SHA before modifying
contracts, renderer implementation or QA. The Run 11 merge SHA
(`5eeffadbbd928f4a03644d6e8ff267a6d5795316`) is historical Run 11 closure
evidence, not the future Pre-Run-12 implementation base.

The hardening exit requires evidence that:

1. `AcceptedDesignArtifact` remains the sole Factory design authority;
2. DesignProvider/Stitch remains generation/evidence only;
3. Astro remains the sole ordinary renderer;
4. accepted design maps deterministically into governed implementation policy;
5. ordinary pages use registered reusable components/variants;
6. registered IDs/variants exactly match governed implementations;
7. approved semantic tokens govern production styling;
8. coding agents cannot silently invent new design primitives;
9. component APIs are reviewed before implementation and are bounded/documented;
10. fixture/showcase coverage uses real production implementation;
11. component accessibility is automatically checked;
12. visual regression detects accidental implementation drift;
13. blocking unknown tokens/components/variants fail deterministic QA;
14. implementation-policy changes invalidate old production through existing
    renderer-policy lineage;
15. exact implementation-contract digest is provable in production evidence;
16. no parallel Stitch renderer or unnecessary provider call was introduced;
17. component reuse can be measured for the Run 12 multi-page proof.

Builder verification remains separate from independent QA. The hardening PR may
merge only after independent exact-SHA GO under repository merge governance.
