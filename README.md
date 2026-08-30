# Factory

Factory is an autonomous system for creating, publishing, and operating
SEO/content websites. This repository currently contains:

**structured SiteTask → strong-isolation gate → isolated Codex execution → exact-target scope/integrity checks → Foundation QA → dynamic task-page QA → semantic verification → bounded repair → structured TaskResult**

See `docs/architecture.md` for the design.

## Prerequisites

- Node.js >=22.12.0
- pnpm 11 (`corepack enable` if needed)
- Codex CLI authentication (`@openai/codex` is pinned at `0.150.1`). Factory
  copies only `auth.json` into an ephemeral worker-specific runtime directory.
- Colima + Docker CLI, using the dedicated `factory-sandbox` profile below.

## Install

```bash
pnpm install
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
| `pnpm factory site-task <task.json>` | Execute one SiteTask end to end with bounded automatic repair (requires Codex auth) |

## Running a site-task

```bash
pnpm factory site-task packages/contracts/fixtures/create-roof-repair.json
```

The executor validates the task and verifies the working tree is clean. Before
creating a worker it verifies the exact dedicated Colima mounts, Linux Docker
server, inner-sandbox user-namespace policy, and pinned worker image. A missing or unsafe profile returns
`STRONG_EXECUTION_ISOLATION_UNAVAILABLE`; Factory never falls back to
host-readable `workspace-write` execution.

With an approved backend, the bounded loop remains specified as follows:

1. **Attempt 1 (Initial)**: Runs Codex only inside the approved outer isolation boundary; the inner Codex sandbox must retain disabled tool network and web search.
2. **Exact scope validation**: Derives one page path from the validated slug and evaluates NUL-delimited Git delete/add evidence, modes, and filesystem types. Renames, symlinks, executables, gitlinks, and unrelated pages fail terminally.
3. **Ignored-input integrity**: Compares content-hashed ignored/build-input state around Codex, including `.env*`, `.astro`, and `node_modules`. Mutations fail terminally before QA.
4. **Factory QA Oracle**: Runs unchanged Foundation `pnpm qa`, then Factory-owned dynamic Playwright QA for the requested route on desktop and mobile.
5. **Task verification**: Parses fresh built HTML and checks exact semantic title, H1, description, canonical origin/path, and route existence.
6. **Automatic Repair Loop**: Dynamic/static quality failures produce a bounded `FailureReport` and can retry; security failures never retry.
7. **Outcomes**:
   - `succeeded`: Full verification passes on attempt 1, 2, or 3.
  - `failed`: Non-repairable execution/input/security defect (including unavailable isolation, scope/type violation, ignored-input mutation, timeout, or Codex exit).
  - `needs_review`: Bounded attempts exhausted (3 failed repair attempts) or no source progress made on repair.

Factory's module rule is **READ MANY / WRITE FEW**. The version-controlled
registry contains only current modules; accepted contracts, control-plane,
configuration, QA, and repository-policy areas are protected by default.
`create_page` receives write authority only for its exact target page. Reading
or importing another module never grants permission to modify it, and tasks
cannot declare a broader policy in their input.

Run artifacts land in `.factory/runs/<runId>/` (gitignored):
- `task.json`, `base-commit.txt`, `task-result.json`, `diff.patch`, `changed-files.txt`
- `attempts/<attemptNumber>/`:
  - `codex-output.jsonl`, `codex-stderr.txt`, `codex-version.txt`, `codex-last-message.txt`
  - `changed-files.txt`, `diff.patch`
  - `git-evidence.raw.z`, `integrity-baseline.json`, `integrity-current.json`
  - `foundation-qa-*.txt`, `dynamic-qa-*.txt`, `task-qa-spec.json`, aggregate `qa-*.txt`
  - `task-verification.json`
  - `failure-report.json` (when failing repairably)
  - `attempt-result.json`

Temporary worktrees under `.factory/worktrees/` are always removed at the end of the run.

Timeouts are bounded and env-configurable: `FACTORY_DEPS_TIMEOUT_MS` (5 min),
`FACTORY_CODEX_TIMEOUT_MS` (20 min), `FACTORY_QA_TIMEOUT_MS` (15 min), `FACTORY_MAX_ATTEMPTS` (default: 3).

## QA artifacts

Each `pnpm test` run captures full-page screenshots to
`sites/starter/qa-artifacts/` (gitignored, regenerated every run):

- `homepage-desktop.png`, `homepage-mobile.png`
- `service-desktop.png`, `service-mobile.png`
- `article-desktop.png`, `article-mobile.png`
- `404-desktop.png`, `404-mobile.png`

Traces and error contexts for failed tests land in
`sites/starter/test-results/`.

## Configuration

Copy `.env.example` to `.env` in the repository root (or create `sites/starter/.env`)
to configure environment variables.

- **`PUBLIC_SITE_URL`**: Canonical origin of the site. Used for canonical `<link>`,
  Open Graph URLs, and JSON-LD `@id` / `url` properties.
  - **Local default**: `http://localhost:4321` when unset.
  - **Releasable builds**: Set `PUBLIC_SITE_URL=https://yourdomain.com` in `.env` or
    in the shell environment (e.g. `PUBLIC_SITE_URL=https://summitroofing.example.com pnpm build`).
    Shell-provided values always take precedence over `.env` files.
  - **QA acceptance suite**: Automatically builds and tests with a reserved non-production
    origin (`https://test.example.com`) by default to assert correct canonical generation.
- **`FACTORY_QA_PORT`**: Optional TCP port for Playwright preview server (default: `4321`).
  Allows isolated concurrent QA runs across separate worktrees.
