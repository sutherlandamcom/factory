# OpenRouter / paid-model cost-control handoff

Recorded after the Sutherland one-page workflow proof. Values below are a point-in-time observation; rules are durable, balances are not.

## Point-in-time observed state

- key monthly limit: `$25.00`; used `$19.56`; key headroom `$5.44`
- account balance/budget view: `$48.00` total; used `$42.65`; account headroom `$5.35`
- effective immediate headroom is the lower applicable constraint (`~$5.35` at this observation)
- when usable key headroom is effectively exhausted, provider 402 failures can consume a whole worker attempt without producing a candidate

Do not treat these numbers as current after this date. Provider preflight must query/verify current usable state where APIs allow it.

## Primary cost drivers observed

1. `site-task` worker attempts: each attempt is a fresh agent/runtime exploration; failed attempts consume full cost with no accepted result.
2. senior/Opus escalation: materially more expensive and must not be triggered to compensate for trusted QA/environment defects.
3. expensive planning/writing pipelines: accepted artifacts should be reused rather than regenerated without need.
4. live eval/smoke calls: only run when they answer a concrete acceptance question.

## Execution rules

1. **Precheck before paid execution.** Check effective provider/key budget, provider usability and `pnpm factory db check` (plus other required environment preconditions). If insufficient, stop before model invocation.
2. **One-shot economics.** Run paid generation only after validated/approved inputs and readiness are complete. Iterate on specs/packets locally/deterministically first.
3. **Put known answers in bounded inputs.** Paid workers should receive exact target, accepted content/truth, relevant components/design implementation references and explicit constraints. Do not pay them to rediscover facts Factory already knows.
4. **Classify before retry.** Inspect failure artifacts. If cause is trusted tests/ports/environment/provider state, fix that layer first, then run one clean new execution with a new idempotency key and preserved lineage.
5. **Known historical environment traps.** A local test DB URL was observed on 5432 while the container exposed 5433; an orphaned `astro preview` on 4321 also caused QA friction. Do not hardcode these as universal truths; detect port/DB readiness explicitly.
6. **Bound scope.** Prefer one page/one bounded production unit. Accepted remediation should be small trusted changes when possible rather than complete regeneration.
7. **Persist usage telemetry.** Record provider/model/token/cost data in attempt/run evidence whenever the provider returns it.

## vNext implication

The trusted backend, not the Dashboard, owns paid-execution preflight and retry policy. A UI button may display readiness, but direct API calls must fail closed if provider budget/readiness or accepted-input gates are unsatisfied.
