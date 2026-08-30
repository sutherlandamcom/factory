# Production Delivery MVP — Build Report

## Candidate

- Starting accepted SHA: `aec6ab20cbb35df24278599b077cb5a53f4e5da3`
- Branch: `feat/production-delivery-mvp`
- Candidate HEAD SHA: report the exact PR head SHA in the PR and final handoff;
  a commit cannot embed its own hash without changing that hash.
- Provider: Cloudflare Workers Static Assets
- Wrangler: `4.127.1` (exactly pinned)
- Live Cloudflare smoke test: not performed; normal PR QA uses deterministic
  provider substitutes and no production credentials.

## Delivered architecture

Factory now has a narrow trusted operation that fetches `origin`, resolves
exact current `origin/main`, prepares a disposable detached worktree, installs
the frozen lockfile offline, and builds `sites/starter` once with
`PUBLIC_SITE_URL` set to the site's configured production origin. A stable
SHA-256 digest covers sorted relative file paths plus exact file contents.

The one `dist/` artifact is uploaded with `wrangler versions upload`. Factory
requires one valid `version-upload` NDJSON record containing the configured
Worker identity, version ID, and HTTPS preview URL. The existing Playwright
suite runs remotely against that preview while continuing to assert production
canonical, OpenGraph, and JSON-LD URLs. No second build or upload occurs.

After preview QA, Factory re-fetches `origin/main` and rejects the candidate if
the accepted branch moved during the run. Immediately before production
mutation, Factory reads structured Cloudflare
deployment state, compares it with the latest Factory-known good version, and
persists `promoting`. It then deploys the exact preview-verified version at
100%, validates structured mutation success, confirms the active version, and
runs Playwright through the real production hostname. Only that final QA may
set `verified`.

On production QA failure, Factory rolls back only to an explicit recorded
known-good version ID and verifies production again. Successful recovery is
`rolled_back`, never candidate success. Missing rollback targets, rollback
failure, verification failure, and provider drift become `needs_review`.

## Configuration and persistence

Migration `0002_numerous_newton_destine.sql` adds nullable
`sites.cloudflare_worker_name` / `sites.production_url` and one `deployments`
table. Each deployment snapshots the configured target and stores only the
operational provenance required for status, rollback, and crash safety.

```bash
pnpm factory site delivery set <siteKey> \
  --worker <workerName> \
  --production-url <https://origin>
pnpm factory deploy <siteKey>
pnpm factory rollback <siteKey>
```

The Cloudflare Worker, production hostname, DNS/routes, and certificates must
already be provisioned. Factory performs no bootstrap infrastructure changes.

## Credential boundary

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` enter only a dedicated,
allowlisted Wrangler child environment. They are absent from the generic
executor environment, Codex, worktree dependency preparation, Astro build,
Playwright, PostgreSQL, `DeploymentResult`, and artifacts. Provider logs and
structured output are bounded and redacted before persistence; each mutation
requires a fresh output path.

## Crash and concurrency safety

Production Delivery reuses the existing PostgreSQL advisory lock. The small
checked status set is:

```text
preparing → uploaded → preview_verified → promoting → promoted → verified
                                                       ↘ rolled_back
                                                       ↘ needs_review
```

On restart, only dangerous `promoting` and unverified `promoted` rows are
reconciled. Candidate-active resumes production QA; previous-active verifies
the rollback; any third version is drift and requires review. The recovery
invocation does not silently start another deployment.

## Evidence and tests

Unit coverage includes accepted `origin/main` selection, stable artifact
digests, missing/invalid target configuration, credential isolation, malformed
and stale structured output, split-traffic drift, preview-QA promotion blocking,
exact-version promotion, production-QA gating, exact known-good rollback,
first-deployment failure without rollback, crash reconciliation, protected
module ownership, and remote Playwright mode without a local server.

Real PostgreSQL 18 coverage validates the migration, target snapshot, status
constraint, and known-good provenance. Full commands and their final results
are:

```text
pnpm qa
  PASS — check/build complete, Factory tests 121/121,
         Playwright 8 passed / 2 intentional task-QA skips

FACTORY_TEST_DATABASE_URL=postgresql://...@localhost:54329/factory_test \
  pnpm --filter @factory/factory run test:persistence
  PASS — PostgreSQL 18 integration 19/19

pnpm --filter @factory/factory exec wrangler deploy --dry-run \
  --config sites/starter/wrangler.jsonc ...
  PASS — Wrangler 4.127.1 read 23 static assets, no bindings
```

## Deployment evidence

`.factory/deployments/<deploymentId>/` retains the result, source SHA, artifact
digest, redacted structured Wrangler mutation records, bounded provider logs,
and preview/production/rollback QA evidence. It does not retain a second build
or permanent copy of `dist/`.

## Deferred scope and residual risks

- No Cloudflare account, Worker, DNS, route, custom-domain, certificate, or
  Access provisioning.
- No live provider smoke test in PR CI; operator credentials are intentionally
  absent.
- On the first Factory-managed delivery, an existing single-version production
  deployment may be captured as the rollback candidate, but it becomes
  known-good only if rollback production QA passes.
- Versioned preview URLs remain public unless provisioners add protection
  outside this MVP.
- Wrangler rollback eligibility remains subject to Cloudflare's retained
  version limit and binding compatibility, though this static-only Worker has
  no runtime bindings.
- No automatic deploy-on-merge, dashboard, scheduler, multi-provider layer,
  environment/release platform, canary, or generic recovery engine.

Terminal implementation status: `IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`.
