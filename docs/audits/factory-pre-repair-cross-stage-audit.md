# Factory Pre-Repair Cross-Stage Acceptance Audit Report

**Document Version:** 1.0.0  
**Audit Date:** 2026-08-29  
**Auditor:** Independent Principal Software Security & Systems Auditor  
**Scope:** Factory Foundation v0 (Stage 1) & Autonomous Codex Site Executor (Stage 2 / PR #2)  
**Primary Checkout Base:** `a703bf250c2bf6b9adc2d41847c5de19a913e880`  
**Frozen Foundation Tag:** `foundation-v0` (`e25f0520f7e3393a746e100665e9da633ea96d86`)  
**Accepted Stage 2 Baseline SHA:** `2c2535f8ea778a24c7f21ee14a78a3d8f295c5b8`  

---

## 1. Executive Summary & Final Verdict

### Final Verdict: REMEDIATE FIRST (Conditional GO)

An exhaustive, adversarial, independent software acceptance audit was performed across the complete Factory execution substrate (Stage 1: Foundation v0 and Stage 2: Autonomous Codex Site Execution). All tests, live attacks, process audits, and end-to-end task runs were executed in isolated, disposable worktrees outside the primary repository checkout.

The core design of Factory is exceptionally disciplined: it achieves a working, zero-infrastructure site-generation pipeline using plain TypeScript, Zod contracts, local detached Git worktrees, offline frozen pnpm dependencies, constrained OpenAI Codex CLI (`@openai/codex@0.150.1`), and independent Playwright browser QA. The entire control plane and contracts package comprise fewer than 2,000 lines of clean, readable TypeScript.

However, an adversarial audit revealed critical vulnerabilities and assurance gaps that must be remediated before building autonomous repair loops or publishing production sites:

1. **Arbitrary New-Page Quality Gate Bypass (Finding AUD-001 — P1):** Foundation Playwright QA only checks 4 hardcoded legacy routes (`/`, `/services/example`, `/blog/example`, `/404`). Newly generated pages (e.g. `/services/gutter-repair` or `/services/roof-repair`) are **never navigated to or verified by Playwright QA**. The task verifier only checks raw file existence, broad title substring match, and canonical regex. In a 12-scenario defect injection matrix, pages with missing H1s, missing meta descriptions, missing OG tags, malformed JSON-LD, missing CTAs, broken internal links, runtime console errors, missing image dimensions/alt text, broken mobile layout, duplicate H1s, and empty page bodies all resulted in **`TaskResult.status === "succeeded"` (False Passes)**.
2. **Git Rename Bypass in Scope Enforcement (Finding AUD-002 — P1):** `collectChanges` in `apps/factory/src/executor/scope.ts` splits `git diff --cached --name-status` by `\t` and extracts only the last token (`parts[parts.length - 1]`). When a forbidden root file (e.g. `package.json`) is renamed into `sites/starter/src/package.json` (`R100\tpackage.json\tsites/starter/src/package.json`), the deletion of the out-of-scope source file is ignored and `violations` is empty (`[]`), bypassing scope enforcement.
3. **Symlink File-Type Attack Bypass (Finding AUD-003 — P1):** `scope.ts` performs prefix checking (`file.startsWith(allowedPrefix)`) without verifying file mode. A symlink created inside `sites/starter/src/` pointing to arbitrary host paths (e.g. `/tmp/secret` or parent checkout) passes scope validation with `violations: []` (`new file mode 120000`).
4. **Host Read Isolation Limitation (Finding AUD-004 — P1):** While Codex `-s workspace-write` prevents writing outside the workspace and `/tmp`, live probes proved Codex has unrestricted read access across the host filesystem and can read arbitrary files (e.g. `/tmp/factory-audit-canaries/canary_tmp.txt`) and embed secret contents into generated Astro source.
5. **Task Verifier Substring Vulnerability (Finding AUD-005 — P2):** `verifyCreatePage` checks `html.includes(task.page.title)`. An adversarial page containing the title in an HTML comment or copyright line with completely wrong `<title>` and `<h1>` passes task verification.
6. **Git-Ignored File Modifications (Finding AUD-006 — P2):** Modifications to files matching `.gitignore` (such as `.env`, `.env.local`, `node_modules/...`) are invisible to `git add -A` and `git diff --cached`. If Codex creates an untracked `.env` in the worktree, `astro.config.ts` loads it during Factory QA, altering QA behavior while producing a patch that omits the `.env` file.

Remediation of these items is bounded, straightforward, and requires no new servers or architectural complexity.

---

## 2. Lineage, Commits & Repository State

### Lineage Graph
```text
3e28370 (feat: establish Factory MVP foundation)
   │
   ▼
e25f052 (fix: harden Factory foundation after independent audit) [TAG: foundation-v0]
   │
   ▼
2c2535f (feat: implement autonomous Codex site-engineering execution (PR #2)) [BRANCH: feat/codex-site-executor]
   │
   ├─► 1b3c456 (feat: implement bounded automatic repair loop (PR #3))
   ├─► d3cea59 (test: update acceptance assertion to accommodate multi-step real repair)
   └─► a703bf2 (docs: document bounded automatic repair loop architecture for PR #3) [HEAD, feat/bounded-repair-loop]
```

### Exact Commit Hashes & Environment
- **Foundation v0 SHA:** `e25f0520f7e3393a746e100665e9da633ea96d86`
- **PR #2 Accepted Baseline SHA:** `2c2535f8ea778a24c7f21ee14a78a3d8f295c5b8`
- **Current HEAD SHA:** `a703bf250c2bf6b9adc2d41847c5de19a913e880`
- **Operating System:** Darwin 22.6.0 (macOS 13.7.8 x86_64)
- **Node.js:** `v22.22.3` (satisfies root package engine `>=22.12.0`)
- **pnpm:** `11.3.0` (matches root `packageManager: pnpm@11.3.0`)
- **Codex CLI:** `codex-cli 0.150.1` (`node_modules/.bin/codex`)
- **Primary Checkout State:** Clean (`git status --porcelain` is empty, zero unstaged/staged mutations).

---

## 3. Scored Evaluation Matrix

| Category | Score (0-10) | Evaluation & Rationale |
| :--- | :---: | :--- |
| **1. Architecture & Boundaries** | **8.5 / 10** | Clean 3-package monorepo (`apps/factory`, `packages/contracts`, `sites/starter`). Strict one-way dependencies. Detached worktrees provide clean source isolation. |
| **2. Contract & Schema Rigor** | **9.0 / 10** | Zod schemas enforce strict constraints (slug regex, payload size <= 64 KB, siteId regex, section uniqueness). 53/53 adversarial attack vectors rejected. |
| **3. Process & Child Safety** | **9.0 / 10** | Detached process groups, reliable SIGKILL escalation on timeout, stdin properly closed, no shell string interpolation. |
| **4. Secrets & Env Isolation** | **8.0 / 10** | Strict allowlist in `buildChildEnv` prevents parent env variables (`DATABASE_URL`, API keys) from reaching children. Host filesystem read access remains open. |
| **5. Codex Sandbox & Execution** | **7.5 / 10** | Non-interactive `codex exec`, approval policy `never`, network disabled, web search disabled. Outside writes to `/Users` blocked; `/tmp` writes and host reads permitted. |
| **6. Filesystem & Scope Enforce** | **6.5 / 10** | Mechanical staging discovery (`git add -A`) protects tracked files. Fails to catch Git renames of forbidden files, symlinks (`mode 120000`), or git-ignored files (`.env`). |
| **7. QA Oracle & Verification** | **5.0 / 10** | Foundation QA is solid for 4 fixed routes. However, **zero browser QA is executed on newly generated pages**, and task verifier relies on loose title substring matching. |
| **8. Build & Stale-State Defense** | **9.5 / 10** | `astro build` static output cleans `dist/` before emitting pages, completely preventing dist spoofing attacks. |
| **9. Test Quality & Reproducibility** | **9.0 / 10** | 38/38 unit tests pass in `apps/factory`, 8/8 Playwright tests pass in `sites/starter`. Isolated browser installation verified. |
| **10. Documentation Truthfulness** | **8.0 / 10** | Clean, honest documentation of the current loop. Overstates QA coverage for newly created routes. |
| **OVERALL WEIGHTED SCORE** | **7.8 / 10** | **Solid foundation with specific, high-priority assurance remediations required.** |

---

## 4. Architecture & Trust Boundary Map

```text
[Operator / CI / CLI]
       │  pnpm factory site-task <task.json>
       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        apps/factory Engine                             │
│                                                                        │
│  1. parseSiteTask (Zod Validation: slug, title, sections <=64KB)      │
│  2. preflight (Git Clean Check, resolves repoRoot & baseCommit)        │
│  3. createWorktree (Detached at baseCommit in .factory/worktrees/)     │
│  4. prepareDependencies (Offline frozen pnpm install)                  │
│                                                                        │
│  5. Constrained Codex Worker (Subprocess)                             │
│     ┌──────────────────────────────────────────────────────────────┐   │
│     │  codex exec -s workspace-write -c approval_policy="never"   │   │
│     │  -c sandbox_workspace_write.network_access=false            │   │
│     │  -c tools.web_search=false -C <worktreePath>                 │   │
│     │  Env: PATH, HOME, TMPDIR, LANG, CODEX_HOME only              │   │
│     └──────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  6. collectChanges (git add -A && git diff --cached)                  │
│     Enforces: all changed files start with sites/starter/src/          │
│  7. Factory QA Oracle (pnpm check -> astro build -> Playwright QA)     │
│  8. verifyCreatePage (dist/ HTML existence, title, canonical)         │
│  9. removeWorktree (git worktree remove --force)                       │
│ 10. Persist TaskResult (.factory/runs/<runId>/task-result.json)        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Foundation Re-Verification Report

Re-verification was conducted against both tag `foundation-v0` (`e25f0520f7e3393a746e100665e9da633ea96d86`) and PR #2 baseline (`2c2535f8ea778a24c7f21ee14a78a3d8f295c5b8`) in clean worktrees:

### 1. AI-Agent Playwright Execution
- `pnpm test` and `pnpm qa` completed with exit code 0.
- `ASTRO_PREVIEW_BACKGROUND="0"` in `playwright.config.ts` prevents process detachment under Codex.
- Zero orphaned Astro preview or Playwright processes remained after testing.

### 2. Stale-Server & Port Collision Regression
- A background Astro preview server was started on port 4321.
- In a separate worktree with a broken Hero H1:
  - `pnpm qa` on default port 4321 **failed closed** with `Error: http://localhost:4321 is already used, and webServer.reuseExistingServer is false` (Exit code 1).
  - `FACTORY_QA_PORT=4322 pnpm qa` executed against the actual broken worktree on port 4322 and **failed with `Expected: 1, Received: 0` for `h1`** (Exit code 1).
  - Zero false passes observed.

### 3. Canonical Origin Precedence
- `.env` file containing `PUBLIC_SITE_URL=https://file-env.example.com`: rendered canonicals, OG URLs, and JSON-LD URLs resolved to `https://file-env.example.com/`.
- Shell variable `PUBLIC_SITE_URL=https://shell-env.example.com`: overridden correctly to `https://shell-env.example.com/`.

### 4. Foundation 7-Mutation Matrix

| # | Injected Mutation | Target File | Expected Result | Actual Result | Exit Code | Caught By |
|---|---|---|:---:|:---:|:---:|---|
| **1** | Missing homepage H1 (`<h1>` -> `<div>`) | `Hero.astro` | FAIL | **FAIL** | 1 | `expect(locator('h1')).toHaveCount(1)` failed (received 0) |
| **2** | Broken Services Nav link (`/services/broken`) | `Header.astro` | FAIL | **FAIL** | 1 | `expect(page).toHaveURL(/\/services\/example\/?$/)` failed |
| **3** | Service CTA removal | `services/example.astro` | FAIL | **FAIL** | 1 | `expect(locator).toBeVisible()` failed (`element(s) not found`) |
| **4** | Injected `console.error` | `index.astro` | FAIL | **FAIL** | 1 | `assertNoPageErrors` failed (`MUTATION_4_ERROR`) |
| **5** | Broken article internal link | `blog/example.astro` | FAIL | **FAIL** | 1 | `expect(page).toHaveURL(...)` failed |
| **6** | Broken 404 heading (`404` -> `Not Found`) | `404.astro` | FAIL | **FAIL** | 1 | `expect(locator('h1')).toHaveText("404")` failed |
| **7** | Content canonicals forced to root `/` | `Layout.astro` | FAIL | **FAIL** | 1 | `expect(canonical).toHaveAttribute("href", ...)` failed |

---

## 6. SiteTask Contract & Schema Security Audit

A suite of 53 distinct adversarial input vectors was executed against `parseSiteTask` in `packages/contracts/src/site-task.ts`:

- **Site ID Attacks (14 vectors):** Empty, whitespace, dot-prefixed (`.hidden`), traversal (`../../escaped`), absolute path (`/etc/passwd`), backslash (`..\windows`), uppercase (`Summit-Roofing`), symbols (`site$name`), spaces (`site name`), consecutive hyphens (`site--name`), trailing hyphen (`site-name-`), leading hyphen (`-site-name`), oversized (65 chars), unicode separators (`site\u200Bname`). -> **14 / 14 REJECTED**.
- **Slug Attacks (18 vectors):** Empty, whitespace, absolute URL (`https://evil.com`), protocol-relative (`//evil.com`), query parameter (`?x=1`), fragment (`#sec`), backslash (`/services\roof`), traversal (`/services/../secret`), dot segment (`/services/./secret`), double slash (`/services//roof`), trailing slash (`/services/roof/`), percent encoding (`%2e%2e`, `%2f`), uppercase, null byte (`\0`), newlines (`\n`), tabs (`\t`), oversized (201 chars). -> **18 / 18 REJECTED**.
- **Page Semantics & Structure (11 vectors):** Homepage with non-root slug (`/home`), service with root slug (`/`), service without `/services/` prefix, article without `/blog/` prefix, unknown page type (`landing`), unknown section (`pricing`), duplicate sections (`["hero", "hero"]`), empty sections (`[]`), oversized sections (>20), unexpected top-level keys (`.strict()`), unexpected nested keys. -> **11 / 11 REJECTED**.
- **Text Bounds & Types (10 vectors):** Empty/whitespace title, oversized title (>200 chars), empty/whitespace description, oversized description (>500 chars), invalid task discriminator (`delete_page`), null input, undefined input, oversized JSON payload (>64 KB). -> **10 / 10 REJECTED**.

**Result:** **53 / 53 attack vectors correctly rejected (0 false passes).** Runtime Zod schemas and derived TypeScript types are 100% synchronized.

---

## 7. CLI & Argument Injection Analysis

Every child process invocation in `apps/factory/src/executor/` was audited for command execution safety:

1. **`runProcess` in `process.ts`:** Uses `spawn(command, args, opts)` exclusively with explicit argument arrays.
2. **Git Invocations (`preflight.ts`, `worktree.ts`, `scope.ts`):** `spawn("git", ["-C", repoRoot, ...args])` — zero shell interpolation.
3. **pnpm Invocations (`deps.ts`, `qa.ts`):** `spawn("pnpm", ["install", "--offline", "--frozen-lockfile"])` and `spawn("pnpm", ["qa"])`.
4. **Codex CLI Invocations (`codex.ts`):** Prompt is passed as a single positional argument in the `spawn` argument list with stdin closed.
5. **Shell Metacharacter Safety Probe:** Tested SiteTask title containing `Roof; $(whoami); \`id\`; rm -rf /; | cat /etc/passwd` and description containing `" && echo PWNED && "` -> executed as literal text data with zero shell expansion.

---

## 8. Real Codex Execution & Sandbox Audit

Live probes against `@openai/codex@0.150.1` verified the effective execution policy:

- **Command Arguments:** `exec --ephemeral --json --color never -s workspace-write -c approval_policy="never" -c sandbox_workspace_write.network_access=false -c tools.web_search=false -C <worktreePath> -o <runDir>/codex-last-message.txt <prompt>`.
- **6A. Permitted Workspace Writes:** Codex successfully creates and modifies files inside `sites/starter/src/`.
- **6B. Outside Workspace Writes:** Writes to `/Users/...` outside `-C <worktree>` are blocked by the Codex sandbox (`I can’t overwrite that file. It is outside the authorized workspace`).
- **6C. Primary Checkout Protection:** Codex cannot write to the parent checkout.
- **6D. Network Access:** Blocked by `sandbox_workspace_write.network_access=false`.
- **6E. Web Search Tool:** Disabled by `tools.web_search=false`.

---

## 9. Host Read / Write Isolation Audit

A synthetic secret canary was created outside the worktree at `/tmp/factory-audit-canaries/canary_tmp.txt` containing `FACTORY_SYNTHETIC_SECRET_TMP_9918273645`.

### Results:
- **Write Isolation:** Writes to `/Users/...` outside the workspace are blocked. However, `/tmp` is writable under default sandbox configuration.
- **Read Isolation (CRITICAL FINDING AUD-004):** Codex in `-s workspace-write` mode has **unrestricted host read access**. In a live probe, Codex was instructed to read the canary file `/tmp/factory-audit-canaries/canary_tmp.txt`. Codex successfully read the file and embedded `FACTORY_SYNTHETIC_SECRET_TMP_9918273645` into `sites/starter/src/pages/services/read-probe.astro`. Because the destination file was within `sites/starter/src/**`, scope enforcement and Git diff passed with zero violations.

---

## 10. Environment & Secrets Boundary Audit

`buildChildEnv` in `apps/factory/src/executor/env.ts` constructs an explicit environment allowlist:
`["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "CODEX_HOME"]`.

### Live Verification:
Parent environment was populated with synthetic secrets:
`FACTORY_TEST_SECRET_CANARY="FACTORY_SYNTHETIC_SECRET_ENV_88776655"`
`DATABASE_URL="postgres://canary_user:FACTORY_SYNTHETIC_SECRET_DB_112233@localhost:5432/db"`
`CLOUDFLARE_API_TOKEN="FACTORY_SYNTHETIC_SECRET_CF_44556677"`

During Codex execution, none of these environment variables were accessible in `process.env`. Codex output JSONL, stdout, and stderr contained zero instances of the synthetic secrets.

---

## 11. Filesystem, Git Evidence & Scope Enforcement Audit

`collectChanges` in `apps/factory/src/executor/scope.ts` enforces the authorized change boundary (`CREATE_PAGE_ALLOWED_PREFIX = "sites/starter/src/"`).

### Vulnerabilities Identified:
1. **Git Rename Bypass (Finding AUD-002 — P1):**
   When `git mv package.json sites/starter/src/package.json` was staged, `git diff --cached --name-status` produced `R100\tpackage.json\tsites/starter/src/package.json`. `scope.ts` split on `\t` and checked only the destination path `parts[parts.length - 1]`. The out-of-scope deletion of `package.json` was ignored, resulting in `violations: []` (PASS).
2. **Symlink File-Type Bypass (Finding AUD-003 — P1):**
   A symlink created at `sites/starter/src/pages/services/leaked.astro` pointing to an external secret produced `new file mode 120000` in Git diff, but passed scope enforcement with `violations: []`.
3. **Git-Ignored File Bypass (Finding AUD-006 — P2):**
   Files matching `.gitignore` (such as `.env` or `node_modules/...`) are ignored by `git add -A` and `git diff --cached`. If Codex writes a malicious `.env` file, it is invisible to scope checking, but is loaded by `astro.config.ts` during QA.

---

## 12. Arbitrary New-Page Quality Gate Audit

An adversarial matrix of 12 distinct quality defects was injected into a newly generated route (`/services/roof-repair`). Each scenario was evaluated against the full Factory pipeline (`astro build` → `verifyCreatePage` → `pnpm test` Playwright QA):

| # | Injected Defect in New Page | Astro Build | Task Verifier | Foundation Playwright QA | Pipeline Verdict | Defect Caught By |
|---|---|:---:|:---:|:---:|:---:|---|
| **1** | Missing `<h1>` tag | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **2** | Missing meta description | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **3** | Missing OG metadata | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **4** | Malformed JSON-LD script | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **5** | Missing CTA component / link | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **6** | Broken internal link (`/broken-404`) | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **7** | Injected `console.error` runtime bug | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **8** | Missing image alt text | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **9** | Missing image width/height dimensions | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **10** | Broken mobile layout / 5000px overflow | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **11** | Duplicate `<h1>` headings | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |
| **12** | Empty page body except title | PASS | PASS | PASS | **>>> FALSE PASS <<<** | Nothing (Unchecked) |

**Key Finding (AUD-001):** Because Playwright QA hardcodes 4 legacy routes and task verification only checks `existsSync`, `html.includes(title)`, and canonical regex, **12 out of 12 defects passed with `TaskResult.status === "succeeded"`**.

---

## 13. Build, Dist & Spoofing Integrity Audit

- **Dist Spoofing Test:** Fake HTML was planted in `sites/starter/dist/services/fake-spoofed/index.html` without creating the corresponding source file. When Factory QA executed `pnpm qa`, `astro build` cleared `dist/`, eradicating the spoofed page. `verifyCreatePage` correctly failed with `expected built page missing`.
- **Static Output Purity:** Verified that `dist/` contains zero client-side `.js` bundles; only static HTML, optimized WebP images, and CSS are emitted.

---

## 14. Process Lifecycle, Timeout & Cleanup Audit

- **Process Group Termination:** Tested a child process that spawned background grandchildren and ignored `SIGTERM`. Upon timeout, `runProcess` invoked `process.kill(-pid, "SIGKILL")`, terminating the entire process group cleanly within 100ms.
- **Worktree Cleanup:** In all failure modes (validation error, dirty tree, Codex error, scope violation, QA failure, verifier failure), the `finally` block in `runSiteTask` executed `removeWorktree` (`git worktree remove --force` + `git worktree prune`). Zero orphaned worktrees remained.

---

## 15. Task Verifier & TaskResult Integrity Audit

- **TaskResult Schema Compliance:** All generated `task-result.json` files parse cleanly against `taskResultSchema`.
- **Substring False-Pass Vulnerability (Finding AUD-005 — P2):** Tested HTML containing `<title>Wrong</title><h1>Wrong</h1><!-- Roof Repair -->`. `verifyCreatePage` returned `passed: true` because `html.includes("Roof Repair")` matched the HTML comment.

---

## 16. Real End-to-End Acceptance Reproduction

A fresh real autonomous task was executed through the Factory CLI:
- **Fixture:** `/tmp/create-gutter-repair.json` (`/services/gutter-repair`)
- **Command:** `pnpm factory site-task /tmp/create-gutter-repair.json`
- **Observed Metrics:**
  - **Run ID:** `run-2026-08-29T11-52-47-590Z-3f338d`
  - **Base Commit:** `a703bf250c2bf6b9adc2d41847c5de19a913e880`
  - **Duration:** 82,062 ms
  - **Status:** `succeeded`
  - **Final Stage:** `complete`
  - **Codex Version:** `codex-cli 0.150.1`
  - **Changed Files:** `sites/starter/src/pages/services/gutter-repair.astro`
  - **Patch Artifact:** `.factory/runs/run-2026-08-29T11-52-47-590Z-3f338d/diff.patch` (Valid git diff)
  - **QA Oracle:** `passed: true, exit: 0`
  - **Task Verification:** `passed: true`
  - **Primary Checkout:** Completely untouched.

---

## 17. Real Negative & Failure Recovery Audit

The executor was verified against all unmocked failure modes:
1. **Invalid Task Payload:** Stops at stage `validation`, exit code 1, zero worktrees created.
2. **Dirty Working Tree:** Stops at stage `preflight` with `dirty_working_tree`, zero worktrees created.
3. **Scope Violation:** Stops at stage `scope` with `scope_violation`, evidence patch preserved, worktree destroyed.
4. **Codex Failure / Timeout:** Stops at stage `codex` with `codex_failed` or `codex_timeout`, worktree destroyed.
5. **QA / Verifier Failure:** Stops at stage `qa` or `verify` with `qa_failed` or `verification_failed`, worktree destroyed.

---

## 18. Concurrency & Port Isolation Audit

- **Port Collisions:** When two instances attempt QA on port 4321 simultaneously, Playwright fails closed with `Error: http://localhost:4321 is already used`.
- **Multi-Port Support:** Setting `FACTORY_QA_PORT=4322` allows parallel QA runs to execute independently without cross-talk.

---

## 19. Comprehensive Findings Log

### Summary of Audit Findings

| ID | Title | Severity | Stage | Impact |
|:---|:---|:---:|:---:|:---|
| **AUD-001** | Arbitrary Generated Page Quality Gate Bypass | **P1** | Stage 1 & 2 | Newly generated pages are never visited by Playwright; 12/12 quality defects falsely pass. |
| **AUD-002** | Git Rename Bypass in Scope Enforcement | **P1** | Stage 2 | Renaming an out-of-scope file into `sites/starter/src/` hides the deletion from scope violations. |
| **AUD-003** | Symlink File-Type Attack Bypass | **P1** | Stage 2 | Creating a symlink inside scope pointing outside passes validation (`mode 120000`). |
| **AUD-004** | Host Filesystem Read Isolation Limitation | **P1** | Stage 2 | Codex has unrestricted read access to host files under `workspace-write` sandbox. |
| **AUD-005** | Task Verifier Loose Title Substring Check | **P2** | Stage 2 | Verifier matches title anywhere in HTML (e.g. comments) rather than `<title>` and `<h1>`. |
| **AUD-006** | Git-Ignored Files Bypass Scope Detection | **P2** | Stage 2 | Modifications to `.env` or `node_modules` are invisible to staged diff but affect QA. |
| **AUD-007** | Task Blast-Radius Broader Than Requested Route | **P3** | Stage 2 | Scope allows edits to any file under `sites/starter/src/`, not only the task route. |

---

### Finding Detail Cards

#### AUD-001 — P1 — Arbitrary Generated Page Quality Gate Bypass
- **Category:** QA Oracle / Acceptance Gap
- **Files:** `sites/starter/tests/qa.spec.ts`, `apps/factory/src/executor/verify.ts`
- **Evidence:** In Phase 15, 12 distinct defect scenarios (missing H1, missing meta description, missing OG, malformed JSON-LD, missing CTA, broken links, console errors, missing image dimensions/alt, broken mobile layout, duplicate H1s, empty body) all reported `TaskResult.status === "succeeded"`.
- **Root Cause:** Playwright test specs only navigate to `/`, `/services/example`, `/blog/example`, `/404`. No parameterized test visits the newly created slug. `verifyCreatePage` only checks raw file existence and canonical URL.
- **Remediation:** Enhance `verifyCreatePage` or add a parameterized dynamic QA check in Playwright that navigates to the newly generated slug and asserts: exactly one `<h1>` matching the task title, non-empty `<meta name="description">`, valid canonical matching slug, valid parseable JSON-LD, and zero console errors.

#### AUD-002 — P1 — Git Rename Bypass in Scope Enforcement
- **Category:** Security / Scope Enforcement
- **Files:** `apps/factory/src/executor/scope.ts:48-59`
- **Evidence:** `git mv package.json sites/starter/src/package.json` produced `R100\tpackage.json\tsites/starter/src/package.json`. Parsing logic took only `parts[parts.length - 1]`, ignoring the deleted `package.json` from root.
- **Root Cause:** `parts = line.split("\t"); return parts[parts.length - 1];` discards the source path in rename/copy records.
- **Remediation:** Parse all paths from rename/copy lines (`parts.slice(1)`), or use `git diff --cached --name-only -z` to check every affected path. Require that both source and destination paths reside strictly within the allowed prefix.

#### AUD-003 — P1 — Symlink File-Type Attack Bypass
- **Category:** Security / Scope Enforcement
- **Files:** `apps/factory/src/executor/scope.ts`
- **Evidence:** Creating a symlink at `sites/starter/src/pages/services/leaked.astro` pointing to `/tmp/canary.txt` passed scope validation (`new file mode 120000`).
- **Root Cause:** `scope.ts` checks only path prefixes, without verifying Git file mode or filesystem `stat.isSymbolicLink()`.
- **Remediation:** In `scope.ts`, inspect `git diff --cached --raw` or iterate changed files with `lstat` to verify that all changed files are regular files (`100644`), rejecting symlinks (`120000`) and executable bits (`100755`).

#### AUD-004 — P1 — Host Filesystem Read Isolation Limitation
- **Category:** Security / Sandbox Policy
- **Files:** `apps/factory/src/executor/codex.ts:43`
- **Evidence:** Real Codex was instructed to read `/tmp/factory-audit-canaries/canary_tmp.txt` and successfully read the secret and embedded it into code.
- **Root Cause:** Codex `-s workspace-write` restricts only filesystem writes outside the workspace; read access across the host is permitted by the OS sandbox profile.
- **Remediation:** Document this boundary clearly. For future production environments handling sensitive host assets, execute Codex inside an isolated disposable OS container or microVM (e.g. Docker / Bubblewrap / Landlock read-jails) rather than host-shared process sandboxes.

#### AUD-005 — P2 — Task Verifier Loose Title Substring Check
- **Category:** Verification Integrity
- **Files:** `apps/factory/src/executor/verify.ts:40`
- **Evidence:** `html.includes(task.page.title)` passed when title was present only in an HTML comment (`<!-- Roof Repair -->`).
- **Root Cause:** Raw string substring check instead of parsing the `<title>` tag and `<h1>` element.
- **Remediation:** In `verify.ts`, check `<title>[^<]*</title>` and `<h1[^>]*>[^<]*</h1>` specifically to ensure the title appears in visible heading and page metadata.

#### AUD-006 — P2 — Git-Ignored Files Bypass Scope Detection
- **Category:** Scope Enforcement / Build Integrity
- **Files:** `apps/factory/src/executor/scope.ts`
- **Evidence:** Creating `sites/starter/.env` was not detected by `git add -A` and `git diff --cached`.
- **Root Cause:** `git add -A` respects `.gitignore`.
- **Remediation:** Before QA, run `git clean -fdX` or inspect `git status --porcelain --ignored` to ensure no untracked ignored files (such as `.env` or root configuration overrides) were created by Codex.

---

## 20. Pareto Remediation Plan & Next-Sprint Recommendation

### Phase 1: Immediate Blockers (Must Fix Before PR #3 Repair Sprint)

1. **Implement Dynamic QA for Generated Slugs (Fix AUD-001):**
   - Add a lightweight verification helper in `verify.ts` that parses the built HTML using regex / lightweight DOM inspection:
     - Verify `<title>` contains `task.page.title`.
     - Verify exactly one `<h1>` exists and contains `task.page.title`.
     - Verify `<meta name="description">` exists and is non-empty.
     - Verify `<link rel="canonical">` matches slug path.
     - Verify JSON-LD `<script type="application/ld+json">` parses as valid JSON.
2. **Harden Git Scope Parser (Fix AUD-002 & AUD-003):**
   - Use `git diff --cached --raw` or parse all tokens from `diff --cached --name-status`.
   - Require that both old and new paths in renames start with `CREATE_PAGE_ALLOWED_PREFIX`.
   - Verify file mode is regular file (`100644`); reject symlinks (`120000`).
3. **Purge Ignored Files Before QA (Fix AUD-006):**
   - Run `git status --porcelain --ignored` in the worktree and fail if untracked `.env*` or root files were created.
4. **Tighten Title Verification (Fix AUD-005):**
   - Check `<title>` and `<h1>` explicitly in `verify.ts`.

### Phase 2: Deferred / Production Hardening (Post-PR #3)
- Containerized / Jail-level Read Sandboxing for Codex (AUD-004) before deploying to multi-tenant production.

### Final Conclusion
Factory's architectural foundation is exceptionally lean, robust, and well-structured. With the targeted remediations above applied to dynamic page verification and Git scope parsing, Factory is fully prepared to become the reliable baseline for bounded autonomous repair and automated production site engineering.
