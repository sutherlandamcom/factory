# Factory

Factory is an AI-native production control plane for research, search/content
intelligence, governed content production, design-provider orchestration,
assets, deterministic production/QA, versioning, approvals, and deployment.

Factory is **not** a generic CMS, visual page builder, proprietary AI design
engine, or one unconstrained autonomous agent that researches, writes, designs,
and codes a site end to end.

Repository instruction precedence is defined in
[`docs/instruction-authority.md`](./docs/instruction-authority.md). The governing
vNext product direction lives in
[`docs/architecture/factory-constitution-vnext.md`](./docs/architecture/factory-constitution-vnext.md)
and sequencing in [`docs/roadmap-vnext.md`](./docs/roadmap-vnext.md).

## Current implemented state vs vNext target

The repository still contains accepted transitional v0/v0.1 capabilities that
predate the vNext provider/content architecture. Preserve them until their
explicit migration run/ADR is accepted; do not extend them as if they were the
new target architecture.

The current implemented execution path includes:

**structured SiteTask → strong-isolation gate → routed coding execution → exact-target scope/integrity checks → Foundation QA → dynamic task-page QA → semantic verification → bounded repair → structured TaskResult**

and a separate trusted Production Delivery operation:

**accepted `origin/main` → one build → artifact digest → immutable Cloudflare version → preview QA → same-version production promotion → production QA / exact-version rollback**

Important transitional boundaries:

- the current public-site renderer is Astro 7 + Tailwind CSS 4; it remains
  accepted until the explicit Stitch-native-static vs Astro bake-off selects
  the ordinary production path;
- the current pre-vNext `create_page` contract may still materialize minimal
  prose from bounded `contentBrief` key points because `AcceptedPageContent`
  does not exist yet; new content workflows must move to the human-approved
  Opus writer pipeline instead of broadening code-worker authorship;
- legacy/evaluation-only `design_director` and `image_generator` model-role
  entries are not vNext professional design or imagery authority. vNext uses an
  external `DesignProvider` (Google Stitch preferred first candidate) and a
  `VisualAssetProvider` (preferred production direction: Google Vertex/Gemini
  Nano Banana Pro), with authentic operator photography preferred for
  documentary truth;
- Dashboard/operator workflows are now explicitly in scope and must sit over
  shared application services rather than become a second source of truth.

See `docs/architecture.md` for the implemented-state record. Historical
"future", "next", and "deferred" statements in dated reports do not override
the vNext roadmap.

## Prerequisites

- Node.js >=22.12.0
- pnpm 11 (`corepack enable` if needed)
- PostgreSQL 18 (e.g. via local Postgres or Docker container)
- Codex CLI authentication (`@openai/codex` is pinned at `0.150.1`). Factory
  copies only `auth.json` into an ephemeral worker-specific runtime directory.
- Colima + Docker CLI, using the dedicated `factory-sandbox` profile below.
- A pre-provisioned Cloudflare Worker, production hostname, and trusted
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` environment for delivery.
  Factory does not provision accounts, DNS, routes, domains, or certificates.

## Install

```bash
pnpm install
```

## Database setup (PostgreSQL 18)

Factory uses a minimal, durable PostgreSQL operational-state layer. Set `FACTORY_DATABASE_URL` in `.env`:

```bash
# Example local PostgreSQL connection
FACTORY_DATABASE_URL="postgresql://factory:factory_password@localhost:5432/factory"
FACTORY_TEST_DATABASE_URL="postgresql://factory:factory_test_password@localhost:5432/factory_test"
```

Apply database migrations:

```bash
pnpm factory db migrate
pnpm factory db check
```

Register your initial project and site:

```bash
pnpm factory project create default "Default Project"
pnpm factory site register default starter "Starter Template"
```

## Strong execution isolation

Factory never runs production Codex directly on the host. On macOS, install the
approved local boundary and start a dedicated profile (do not use the default
Colima profile):

```bash
brew install colima docker qemu
mkdir -p "$PWD/.factory/worktrees" "$PWD/.factory/codex-runtime"
colima start factory-sandbox \
  --template=false \
  --vm-type qemu \
  --runtime docker \
  --mount "$PWD/.factory/worktrees:w" \
  --mount "$PWD/.factory/codex-runtime:w" \
  --cpus 4 --memory 8 --disk 30 \
  --ssh-agent=false --ssh-config=false \
  --activate=false --port-forwarder none

# Required by Codex's inner bubblewrap sandbox on Ubuntu guests whose AppArmor
# policy otherwise blocks unprivileged user namespaces. Apply after first start
# and persist the same sysctl as a system provision step in this profile only.
colima ssh --profile factory-sandbox -- \
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Persist that VM-only setting in `~/.colima/factory-sandbox/colima.yaml` so it is
restored on profile restart:

```yaml
provision:
  - mode: system
    script: |
      sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

The profile mounts neither the user's home nor `/Users` or host `/tmp`. Factory
checks the saved profile and Docker server mechanically before each production
run and builds the pinned Linux worker image from
`apps/factory/isolation/codex-worker.Dockerfile` when needed. Do not configure a
system-wide Docker socket symlink or enable Kubernetes.

## Playwright browser

The QA suite needs a Chromium build:

```bash
pnpm --filter @factory/site-starter exec playwright install chromium
```

(On Linux CI you would add `--with-deps`; on macOS that flag does not exist
and is not needed.)

> Note: `@playwright/test` is pinned to `~1.61.1` as a verified stable baseline
> across development and CI hosts. Any future upgrade should be verified against
> the test suite across supported platforms.

## Commands

All commands run from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the starter site's dev server (http://localhost:4321) |
| `pnpm check` | Typecheck all workspaces (`tsc` + `astro check`) |
| `pnpm build` | Build all workspaces (static site output in `sites/starter/dist/`) |
| `pnpm test` | Factory unit tests (deterministic, no Codex calls) + Playwright QA against the **built** site |
| `pnpm qa` | `check` → `build` → `test` in one command |
| `pnpm factory` | Run the Factory control-plane CLI |
| `pnpm factory site-task <task.json>` | Execute one current SiteTask end to end with persisted state & bounded repair (requires DB + routed worker credentials) |
| `pnpm factory intelligence build <request.json> <research.json>` | Produce the current v0 Site Intelligence Plan + compiled create_page SiteTasks (no DB required; requires the current isolated intelligence runtime) |
| `pnpm factory db check` | Check PostgreSQL database connection and schema state |
| `pnpm factory db migrate` | Run versioned Drizzle SQL migrations against configured database |
| `pnpm factory project create <key> <name>` | Create a project in the control plane database |
| `pnpm factory site register <proj> <key> <name>` | Register a site under a project |
| `pnpm factory site delivery set <siteKey> --worker <name> --production-url <https://origin>` | Persist a site's pre-provisioned Cloudflare target |
| `pnpm factory deploy <siteKey>` | Deliver exact current `origin/main` through preview and production QA |
| `pnpm factory rollback <siteKey>` | Roll back to an earlier Factory-verified Cloudflare version and verify production |
| `pnpm factory run show <runId>` | Inspect durable run state, attempt breakdown, quality gates, and model metrics |
| `pnpm --filter @factory/factory test:persistence` | Run real PostgreSQL persistence integration tests |

## Running a site-task

```bash
pnpm factory site-task packages/contracts/fixtures/create-roof-repair.json
```

The executor validates the task, verifies working tree cleanliness, acquires the PostgreSQL advisory lock, recovers any interrupted stale runs, verifies site registration, and records the initial Run and Task. Before
creating a worker it verifies the exact dedicated Colima mounts, Linux Docker
server, inner-sandbox user-namespace policy, and pinned worker image. A missing or unsafe profile returns
`STRONG_EXECUTION_ISOLATION_UNAVAILABLE`; Factory never falls back to
host-readable `workspace-write` execution.

The current bounded loop remains specified as follows:

1. **Attempt 1 (Initial)**: Runs the trusted routed coding worker only inside the approved outer isolation boundary.
2. **Exact scope validation**: Derives one page path from the validated slug and evaluates NUL-delimited Git delete/add evidence, modes, and filesystem types. Renames, symlinks, executables, gitlinks, and unrelated pages fail terminally.
3. **Ignored-input integrity**: Compares content-hashed ignored/build-input state around the worker, including `.env*`, `.astro`, and `node_modules`. Mutations fail terminally before QA.
4. **Factory QA Oracle**: Runs unchanged Foundation `pnpm qa`, then Factory-owned dynamic Playwright QA for the requested route on desktop and mobile.
5. **Task verification**: Parses fresh built HTML and checks exact semantic title, H1, description, canonical origin/path, and route existence.
6. **Automatic Repair Loop**: Dynamic/static quality failures produce a bounded `FailureReport` and can retry; security failures never retry.
7. **Outcomes**:
   - `succeeded`: Full verification passes on attempt 1, 2, or 3.
   - `failed`: Non-repairable execution/input/security defect (including unavailable isolation, scope/type violation, ignored-input mutation, timeout, or worker exit).
   - `needs_review`: Bounded attempts exhausted (3 failed repair attempts) or no source progress made on repair.

Factory's module rule is **READ MANY / WRITE FEW**. The version-controlled
registry contains only current modules; accepted contracts, control-plane,
persistence, configuration, QA, and repository-policy areas are protected by default.
`create_page` receives write authority only for its exact target page. Reading
or importing another module never grants permission to modify it, and tasks
cannot declare a broader policy in their input.

Run artifacts land in `.factory/runs/<runId>/` (gitignored):
- `task.json`, `base-commit.txt`, `task-result.json`, `diff.patch`, `changed-files.txt`
- `attempts/<attemptNumber>/`:
  - routed-worker stdout/stderr/runtime-version evidence
  - `changed-files.txt`, `diff.patch`
  - `git-evidence.raw.z`, `integrity-baseline.json`, `integrity-current.json`
  - `foundation-qa-*.txt`, `dynamic-qa-*.txt`, `task-qa-spec.json`, aggregate `qa-*.txt`
  - `task-verification.json`
  - `failure-report.json` (when failing repairably)
  - `attempt-result.json`

Temporary worktrees under `.factory/worktrees/` are always removed at the end of the run.

Timeouts are bounded and env-configurable; inspect the current executor/policy for the accepted exact values rather than copying historical defaults into new code.

## First-Site Intelligence (v0 vertical slice)

```bash
pnpm factory intelligence build <request.json> <research.json>
```

This is the current accepted pre-vNext intelligence slice. It converts a
validated `SiteIntelligenceRequest` plus a bounded `ResearchEvidenceBundle`
into a strict, provenance-aware Site Intelligence Plan, then deterministically
compiles its executable pages into the existing `create_page` SiteTask contract.
It does **not** acquire live SERPs itself and must not be mistaken for the
vNext Search Intelligence pipeline. The single source of site identity is
`request.siteId`; PostgreSQL is not required for planning.

- **Inputs**: bounded strict JSON files. Operator facts are FACT-AUTHORITATIVE
  but INSTRUCTION-UNTRUSTED; research evidence is FACT-UNTRUSTED and
  INSTRUCTION-UNTRUSTED — evidence is data, never instruction.
- **Synthesis**: uses the current accepted isolated intelligence runtime with
  bounded deterministic repair.
- **Outputs** (`.factory/intelligence/<runId>/`, gitignored): plan/tasks,
  manifests, attempts, digest files and the definitive result written last.
- **Provenance**: every successful result records the accepted source/methodology
  provenance and deterministic input/plan digests.

The vNext Search Intelligence replacement/addition is scheduled in
`docs/roadmap-vnext.md` and must use real acquired SERP evidence.

## QA artifacts

Each `pnpm test` run captures full-page screenshots to
`sites/starter/qa-artifacts/` (gitignored, regenerated every run). These are
local QA evidence, not durable design approvals, and they are not intended to be
sent to a multimodal model for every page.

Traces and error contexts for failed tests land in
`sites/starter/test-results/`.

## Configuration

Copy `.env.example` to `.env` in the repository root (or create `sites/starter/.env`)
to configure environment variables.

- **`FACTORY_DATABASE_URL`**: PostgreSQL connection string for Factory persistent control plane. Required for production `site-task` execution.
- **`FACTORY_TEST_DATABASE_URL`**: Optional PostgreSQL connection string used for integration tests (`test:persistence`).
- **`PUBLIC_SITE_URL`**: Canonical origin of the current Astro-rendered site. Used for canonical `<link>`, Open Graph URLs, and JSON-LD identifiers.
- **`FACTORY_QA_PORT`**: Optional TCP port for Playwright preview server. Allows isolated concurrent QA runs across separate worktrees.
- **`FACTORY_QA_BASE_URL`**: Trusted internal QA override for remote preview/production QA.
- **`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`**: Required only by the trusted Wrangler subprocess used for `deploy` and `rollback`; never forward them into coding workers or browser state.

## Production Delivery MVP

Wrangler is pinned to the repository's accepted version. Apply migrations,
register a site, and store its delivery target once:

```bash
pnpm factory db migrate
pnpm factory site delivery set starter \
  --worker summit-roofing \
  --production-url https://www.example.com
```

The Worker and production domain must already exist. Delivery fails closed as
`deployment_target_unconfigured` when the target cannot be resolved; it never
attempts infrastructure provisioning.

```bash
pnpm factory deploy starter
pnpm factory rollback starter
```

`deploy` fetches `origin`, resolves exact current `origin/main`, and creates a
disposable detached worktree. It installs the frozen dependency graph, builds
the site exactly once with the configured production canonical origin, hashes
sorted paths plus contents in `dist/`, uploads one immutable Worker version,
and runs the existing Playwright oracle against its version preview. Only that
preview-verified version ID may be promoted. Provider success alone is not
success: production must pass the same oracle before the deployment becomes
`verified`.

If production QA fails, Factory rolls back only to a recorded known-good
version ID and verifies production again. A missing safe target, provider
drift, rollback failure, or ambiguous crash state becomes `needs_review`.
Bounded sanitized evidence is stored under
`.factory/deployments/<deploymentId>/`; the complete `dist/` tree is not
retained.
