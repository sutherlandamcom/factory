# FACTORY CODE WORKER ROUTING V0 — PRODUCT CUTOVER BUILD REPORT

## A. Starting state

- accepted main: `196a650` (clean, `origin/main` identical)
- PR: #11
- branch: `feat/code-worker-routing-v0`
- old code-worker runtime: isolated Codex CLI worker (`factory-codex-worker:0.150.1`), `migrationActivated: false`
- working tree at start: clean

## B. Upstream runtime verification

Kimi Code CLI (official repo moonshotai/kimi-code):
- version: **0.39.1** (pinned via `KIMI_VERSION` in `kimi-worker.Dockerfile`)
- model id: **`moonshotai/kimi-k3`** (exact OpenRouter slug)
- reasoning effort: **max** (Kimi Code config `default_effort`/`[thinking] effort = "max"`)
- noninteractive mode: `kimi --prompt <p> --output-format stream-json` (prompt via stdin through entrypoint)
- credential mechanism & relay: worker container receives ephemeral dummy token (`factory-relay-token-authorized`) and routes to the local Factory Model Relay (`http://host:port`). The real `OPENROUTER_API_KEY` is held strictly by Factory on the host/executor side.

Claude Code:
- version: **2.1.150** (pinned via `CLAUDE_VERSION` build arg)
- model: **`anthropic/claude-opus-5`** (exact OpenRouter slug); ALL alias env vars pinned (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` = `anthropic/claude-opus-5`) so main AND auxiliary calls cannot silently select another model
- noninteractive mode: `claude -p <p> --output-format json` (prompt via stdin through entrypoint)
- credential mechanism & relay: `ANTHROPIC_AUTH_TOKEN` set to `factory-relay-token-authorized` with `ANTHROPIC_BASE_URL` pointing to the local Factory Model Relay.

## C. Policy & Activation

- policy version: **`factory-model-policy-v0.1`**
- status: **`migrationActivated: true`** (active product path)
- primary: model `moonshotai/kimi-k3`, reasoning `max`, runtime `kimi-code-cli`, gateway `openrouter`
- senior: model `anthropic/claude-opus-5`, reasoning `null`, runtime `claude-code`, gateway `openrouter`
- legacy: `codex-cli` (rollback/reference only; 0 normal routing invocations)
- expected workload distribution: ~70–85% primary / ~15–30% senior (economic guidance only)
- quota enforced?: **NO** (deterministic routing based on task classification and attempt history)

## D. Routing Matrix

- routine (`create_page`):
  - attempt 1: Kimi (initial)
  - attempt 2: Kimi (repair)
  - attempt 3: Claude escalation when the attempt-2 failure is escalation-eligible
- senior-required: Claude from attempt 1
- terminal failures (never escalate, 0 Claude/Codex retries): `scope_violation`, `integrity_violation`, isolation unavailability, invalid task/configuration, preflight/worktree/dependency failures, `qa_timeout`, credential-configuration errors, legacy `codex_failed`/`codex_timeout`
- escalatable failures: `qa_failed`, `verification_failed`, `replay_failed`, `no_progress`, `kimi_execution_failed`, `kimi_timeout`, `kimi_runtime_unavailable`, claude equivalents
- maximum attempts: `MAX_TOTAL_ATTEMPTS = 3` (enforced by contract, runner, and DB SQL check)

## E. Security Boundary & Model Relay

- **Factory Model Relay (`executor/relay.ts`)**:
  - Ephemeral local HTTP server started for each worker/review invocation.
  - Injects real `OPENROUTER_API_KEY` into upstream requests.
  - Strict model validation: rejects any request with a model different from the tier's authorized binding (`moonshotai/kimi-k3` for primary, `anthropic/claude-opus-5` for senior) with HTTP 403 (0 upstream calls).
  - Sanitizes errors and scrubs keys from messages.
  - Cleanly closes in `finally` blocks.
- **Outer container hardening**:
  - Pinned worker images (`factory-kimi-worker:0.39.1`, `factory-claude-worker:2.1.150`).
  - Read-only rootfs, `cap-drop=ALL`, `no-new-privileges`, ephemeral tmpfs, non-root user.
  - Host mounts: restricted to `.factory` runtime paths. No Docker socket, no SSH agent, no host HOME.
  - Dedicated Docker network (`factory-runtime-net`).

## F. Red-Team Classification Hardening (P1-C)

- 402, 404, provider/runtime unavailable, and timeouts are classified as `"inconclusive"` / `"blocked"`.
- Never classified as security "PASS" / "refused".
- Acceptance override requires BOTH `FACTORY_ACCEPTANCE_MODE=1` AND `FACTORY_ACCEPTANCE_RUNTIME=...`. Leftover acceptance environment variables without mode=1 are ignored in normal production.

## G. Test Results & Verification

- **Factory Unit & Regression Tests**: 436/436 PASS (100%)
- **Playwright QA**: PASS (8 passed, 2 skipped by design against `astro preview`)
- **Full Monorepo QA (`pnpm qa`)**: PASS (`tsc --noEmit` + `astro check` + `astro build` + Playwright)
- **PostgreSQL 18 Persistence Suite**: 19/19 PASS against live PostgreSQL 18 instance
- **16 Deterministic Regressions**: All 16 cutover requirements verified in `run.test.ts`, `router.test.ts`, `models-policy.test.ts`, `relay.test.ts`, `worker-runtime.test.ts`.

## H. Final Status

`IMPLEMENTATION COMPLETE — PENDING INDEPENDENT QA`

DO NOT MERGE. Pushed to PR #11 branch for independent QA verification.
