# Search Intelligence v0 — Live Search vertical slice (Macro Run 2)

This document records the implemented-state design carried by PR #21 without overriding the current repository authority chain in `AGENTS.md`, `docs/instruction-authority.md`, the vNext Constitution, or the roadmap.

Macro Run 2 implements the path:

`accepted project/topic -> seed/query -> structured SERP evidence -> derived Search Intelligence -> persisted history -> Dashboard`

without raw-JSON operator workflow.

## Provider authority split

- **StructuredSerpProvider** (`apps/factory/src/search/provider-types.ts`, `serp-dataforseo.ts`) is the measurement layer: what the search engine/provider returned. The v0 adapter is DataForSEO Live Google Organic Advanced using `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` inside the trusted adapter only. Normalization preserves `rank_absolute` ordering; absent features stay absent/unknown rather than being invented. Provider auth/rate-limit/unavailable/invalid-response failures map to typed errors.
- **GroundedSearchProvider** (`grounded-types.ts`) is model-mediated current-web evidence and is never ranking authority. PR #21 ships the boundary plus deterministic fixture support; a native Gemini-grounding production adapter was not yet implemented at the PR #21 candidate and production therefore reports grounded search as unavailable when no provider is configured. Grounded sources must never be labeled as exact SERP positions.
- **Search analyst** (`analyst.ts`) is interpretation only, not factual authority. The v0 role is `search_analyst`, using the configured Gemini Flash model through the existing model gateway. The prompt is bounded, versioned and digested. Factory owns evidence references and review state. Invalid analyst output fails closed; LSI scores, keyword-density targets and generic SEO numeric scores are not part of the contract.

## Contracts and persistence

`packages/contracts/src/search-intelligence.ts` defines strict v1 schemas for SearchRequest, SerpSnapshotData, GroundedSearchData and SearchIntelligenceData. Search Intelligence covers intent, query clusters and primary/secondary relationships, long-tail opportunities, entities, topics, questions, modifiers, vocabulary, related concepts, semantic coverage requirements, user needs, evidence references and review state.

Migration `0005_search_intelligence_v0` adds four search-specific tables:

- `search_runs`
- `serp_snapshots`
- `grounded_search_snapshots`
- `search_intelligence_snapshots`

Search runs bind the exact accepted ProjectInputSnapshot lineage. SERP snapshots retain raw provider payload plus raw digest for reproducible normalization. Completed evidence/intelligence snapshots are immutable. JSONB payloads are reparsed through contracts on read, project isolation is enforced on store reads, and failed runs cannot masquerade as successful evidence.

## Governed application service

`SearchIntelligenceService` performs:

`preflight -> accepted-input resolution -> request normalization -> budget gate -> freshness-cache check -> structured acquisition -> optional grounded research -> analyst -> persistence -> bounded operator read-model`

The default freshness policy is 24 hours and the default recorded-cost daily gate is USD 5 unless configured otherwise. Cache reuse records a new run row without new acquisition spend; explicit refresh creates a new immutable observation rather than mutating old evidence.

## Operator API and Dashboard

The Operator API exposes narrow project-scoped Search workspace/run/history semantics. Browser-controlled input cannot choose provider credentials or arbitrary provider plumbing; trusted backend configuration owns execution mode. Provider secrets never reach the browser and unexpected failures are sanitized.

The Dashboard Search workspace shows accepted-input lineage and staleness, search seeds, query/location/device inputs, search readiness, normalized organic results, SERP features/PAA/related searches when present, a separate grounded-research area explicitly labeled as non-ranking evidence, grouped Search Intelligence, timestamps, provider/model provenance, usage/cost when known and immutable run history.

UI-to-contract tests pin the fields consumed by the Search UI to reduce Dashboard/contract drift.

## Cost and live-vs-CI policy

CI and ordinary unit/integration tests must not call paid providers. Fixture mode is selected by trusted backend environment only and drives deterministic provider/analyst fixtures through the real application/API/Dashboard/persistence path.

Live acceptance is a separate manual/gated operation. At the original PR #21 candidate, one bounded Search analyst call was performed through the existing model gateway and recorded truthful usage/cost/digests; live structured-SERP acceptance remained blocked pending DataForSEO credentials, and a native grounded-search production adapter remained deferred pending provider configuration/implementation.

The real-browser Search E2E exercises Intake acceptance -> Search run -> SERP/grounded/intelligence rendering -> browser reload -> actual Operator service restart without database reset -> persistent history, using the built Dashboard, real Operator service and dedicated PostgreSQL while keeping external paid providers stubbed/fixture-bound in CI.
