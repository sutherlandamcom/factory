# Factory PR #1 — independent foundation audit

Audit date: 2026-08-28  
Audited commit: `3e2837070bc50ef42e9538222602390d5a1ead15` (`feat: establish Factory MVP foundation`)  
Auditor role: independent review; no implementation or remediation performed  
Primary-tree note: the primary checkout already contained uncommitted PR #2 work. All PR #1 execution and mutations used detached disposable worktrees at the commit above. The existing primary-tree changes were not treated as PR #1 evidence and were not modified.

## 1. Executive verdict

### GO WITH REQUIRED FIXES

PR #1 contains a credible minimal foundation: the frozen install succeeds from clean source, workspace linking is real, the Factory CLI imports the contracts package through `workspace:*`, strict checks and static builds succeed, the four intended routes exist, the site is Astro 7/Tailwind 4 with no shipped client JavaScript, responsive images are generated, and the focused browser assertions are discriminating when they actually reach the mutated build.

It is not yet safe to freeze this commit as PR #2's immutable baseline. The ordinary `pnpm test` and `pnpm qa` commands fail inside the exact AI-agent environment PR #2 will use because Astro 7.2 auto-backgrounds `astro preview`. More seriously, Playwright's fixed port plus `reuseExistingServer: !CI` allowed a broken worktree to report `8 passed` and `pnpm qa` exit 0 while testing a pristine server from another worktree. The documented canonical configuration is ineffective, canonicals are not tested, `SiteTask` leaves executor-critical path and section semantics ambiguous, and `AGENTS.md` does not protect tests/configuration from the future coding agent.

These are bounded foundation fixes, not a reason to introduce more infrastructure. Do not start autonomous Codex execution until the P1 findings are closed and independently re-run in clean concurrent worktrees.

## 2. Quality scorecard

| Area | Score | Evidence-based assessment |
| --- | ---: | --- |
| Repository hygiene | 8/10 | One concise commit and 40 tracked files; generated output is ignored and normal commands left the audit worktree Git-clean. Environment ignore coverage and one dead generator need attention. |
| Reproducibility | 5/10 | Frozen and offline installs passed and fresh browser bootstrap passed, but the documented test/QA commands fail under Codex; Node's actual minimum is under-specified. |
| Workspace architecture | 9/10 | Three unique packages, correct `workspace:*` link, no source-relative bypass or tsconfig alias, and no undeclared imported package found. |
| TypeScript correctness | 8/10 | Factory/contracts inherit the strict base; Astro inherits Astro strict; all package checks pass. The one-off `.mjs` tool violates the TypeScript-only rule and is not typechecked. |
| Contract quality | 5/10 | Minimal discriminated task and fixture exist, but executor-critical `siteId`, slug, page-type coherence, and section vocabulary are undefined. |
| Astro architecture | 9/10 | Astro 7.2.9, Tailwind 4.3.3, static output, sensible small components/layouts, and zero framework integrations or client bundles. |
| SEO foundation | 6/10 | Unique titles/descriptions, path-specific canonicals, OG fields, and three JSON-LD types render under a shell-set origin. The documented `.env` path does not work, default output leaks localhost, and QA does not prove most SEO claims. |
| Accessibility | 8/10 | Sensible landmarks, heading order, named navs, alt text, native details/summary, link semantics, keyboard focusability, and responsive layouts were observed. No automated WCAG/contrast gate exists. |
| Performance foundation | 9/10 | Only ~96 KiB static output in this fixture, no client JS, responsive WebP variants, intrinsic image dimensions, eager hero images, and lazy article image. No Lighthouse claim was made or tested. |
| Test quality | 6/10 | Four logical tests run in two projects and the six required behavior mutations fail usefully when served correctly. Coverage omits canonicals, descriptions, most schemas, images, accessibility, and exhaustive links. |
| QA effectiveness | 3/10 | Failure propagation works, but ordinary agent-mode QA cannot start and a stale server can produce a false PASS against broken source. |
| Documentation | 5/10 | Commands and architecture are generally clear, but `.env`, Node, Playwright pin, connected-flow, and test-coverage claims are inaccurate or incomplete. |
| Security/secrets | 8/10 | No secret found in the one-commit history; no remote scripts or dynamic execution. `.env.local` variants are not ignored, and PR #2 must validate/escape external content. |
| Dependency hygiene | 9/10 | All 13 direct entries are used or required; one resolved TypeScript version; no framework runtime; `pnpm audit` found no known vulnerability. |
| PR #2 readiness | 4/10 | CLI/contracts/site seams are extendable, but deterministic owned-worktree QA, an immutable write boundary, canonical proof, and precise task semantics are blockers. |

## 3. Actual architecture

```text
pnpm workspace root (private package; orchestration scripts only)
│
├── apps/factory  (@factory/factory)
│   ├── runs TypeScript source with tsx
│   └── workspace dependency ───────► packages/contracts (@factory/contracts)
│                                      ├── SiteTask TypeScript types
│                                      └── exampleSiteTask value
│
└── sites/starter (@factory/site-starter)
    ├── Astro 7.2.9 static site
    ├── Tailwind CSS 4.3.3 via @tailwindcss/vite
    ├── local astro:assets images via Sharp
    └── Playwright 1.61.1 QA
         └── webServer: build + Astro preview on fixed localhost:4321

Root pnpm qa
  ├── pnpm check: contracts tsc + site astro check, then factory tsc
  ├── pnpm build: site Astro build only (other packages have no build script)
  └── pnpm test: Playwright; its webServer builds the site again, then previews it
```

There is intentionally no PR #1 execution connection from a `SiteTask` to the Astro source. The CLI proves the contracts package link; the starter and its QA are a separate rail. README line 6 presents these as a flow, but no code currently transforms, dispatches, or applies the task. That missing executor is PR #2 scope, not a PR #1 implementation defect; the documentation should describe the two present rails precisely.

Dependency direction is one-way: `@factory/factory` → `@factory/contracts`. The site has no dependency on either package. No tsconfig path aliases or direct relative imports bypass this boundary.

## 4. Reproduction evidence

### Environment and clean-source setup

| Item | Observed value |
| --- | --- |
| OS | macOS 13.7.8, Darwin 22.6.0, x86_64 |
| Node | `v24.15.0` |
| pnpm | `11.3.0` (matches root `packageManager`) |
| Git baseline | detached `3e2837070bc50ef42e9538222602390d5a1ead15` |
| Pre-install local state | no `node_modules`, `dist`, or `.astro` in the clean worktree |
| Initial baseline status | empty `git status --short` |

The primary checkout was already dirty with apparent PR #2 work on `feat/codex-site-executor`; both that branch and `main` pointed to the audited PR #1 commit. This audit used `/tmp/factory-foundation-audit.Dju3kP/...` worktrees and did not use the dirty primary tree to run PR #1 gates.

### Commands and exits

| Command | Exit | Notable output / interpretation |
| --- | ---: | --- |
| `pnpm install --frozen-lockfile` | 0 | All 4 workspace projects; 285 packages; lock resolution skipped; no manifest/lock hash changed. Packages came from the existing pnpm store. |
| `pnpm install --offline --frozen-lockfile` in a second clean detached worktree | 0 | All 285 packages were available in the local store. This proves this host's offline store, not universal offline availability. |
| `pnpm factory` | 0 | Printed version and values loaded from `@factory/contracts`: `type=create_page site=demo slug=/roof-repair`. |
| `pnpm check` | 0 | Three workspace checks; 0 Astro errors/warnings/hints; both `tsc --noEmit` checks completed. |
| `pnpm build` | 0 | Static mode; 4 pages built; 11 WebP outputs generated; no significant build warning. |
| `pnpm test` | 1 | `Error: Process from config.webServer exited early.` Astro left a detached preview process behind in agent mode. Browser tests did not run. |
| `pnpm qa` | 1 | `check` and `build` passed; `test` failed with the same early-exit error. Failure was propagated. |
| `ASTRO_PREVIEW_BACKGROUND=0 pnpm test` | 0 | 8/8 passed when automatic background mode was explicitly disabled. This override is not in repository scripts/config/docs. |
| Fresh isolated `PLAYWRIGHT_BROWSERS_PATH=... playwright install chromium` | 0 | Downloaded Chrome for Testing 149, FFmpeg, and headless shell into an initially empty audit directory. |
| `ASTRO_PREVIEW_BACKGROUND=0 PLAYWRIGHT_BROWSERS_PATH=<fresh> pnpm test` | 0 | 8/8 passed against the freshly downloaded browser; browser QA does not inherently rely on the operator's normal Playwright cache. |
| Package-local `pnpm check` in contracts, factory, and site | 0 / 0 / 0 | Isolated compilation/checking succeeds. |
| `pnpm audit` | 0 | `No known vulnerabilities found`. Registry state is time-sensitive. |
| `pnpm qa` after a deliberate TypeScript error | 2 | Contracts check failed with TS2322; build/test did not run. This proves early-stage failure propagation. |

### Generated output and routes

Generated files included:

- `dist/index.html`
- `dist/services/example/index.html`
- `dist/blog/example/index.html`
- `dist/404.html`
- one CSS file and 11 WebP image variants; no `.js` file

Preview status checks:

| URL | Status |
| --- | ---: |
| `/` | 200 |
| `/services/example` and `/services/example/` | 200 |
| `/blog/example` | 200 |
| `/this-page-does-not-exist` | 404 |
| `/404` and `/404/` | 200 (the concrete 404 document route) |
| `/favicon.ico` | 404 |

Rendered-file inspection found exactly one title, meta description, canonical, and H1 on every built HTML file. The three content routes contained parseable `LocalBusiness`, `Service`, and `Article` JSON-LD respectively. Internal hrefs resolved to the three expected content routes. Default canonicals were `http://localhost:4321/...`.

### Git state after normal commands

After install, check, build, test attempts, isolated-browser tests, and screenshot generation, `git status --short` in the detached baseline was empty. Lockfile and manifest SHA-256 values were unchanged. `dist`, `.astro`, `test-results`, and `qa-artifacts` were ignored. A later manual browser-CLI inspection created `.playwright-cli/`; that audit-only artifact was moved outside the worktree and is not attributable to `pnpm qa`.

## 5. Acceptance criteria matrix

| Intended PR #1 requirement | Result | Evidence |
| --- | --- | --- |
| pnpm monorepo foundation | PASS | Root workspace includes `apps/*`, `packages/*`, and `sites/*`; frozen install succeeds. |
| Declared package-manager version | PASS | `packageManager: pnpm@11.3.0`; observed pnpm 11.3.0. |
| Strict TypeScript | PARTIAL | Factory/contracts inherit strict base and Astro inherits Astro strict; all checks pass. The unreferenced placeholder generator is `.mjs`, contrary to the TypeScript-only policy. |
| `apps/factory` | PASS | Minimal non-server CLI runs and imports the fixture from the workspace package. |
| `packages/contracts` | PARTIAL | Package boundary and exports work, but executor-critical task semantics are ambiguous. |
| `SiteTask` contract and fixture | PARTIAL | Discriminated `create_page` and typed fixture exist; unsafe/contradictory identifiers still compile. |
| Astro 7 site | PASS | Resolved `astro@7.2.9`; static output confirmed. |
| Tailwind CSS 4 | PASS | Resolved Tailwind/plugin 4.3.3; global CSS imports Tailwind; generated CSS renders correctly. |
| Reusable Astro components/layouts | PASS | All seven components and both layouts are used; no large duplicated page shell. |
| Homepage | PASS | Built, 200, semantic H1/sections/internal links, desktop/mobile visual evidence. |
| Example service page | PASS | Built, 200, service schema, CTA, internal links, responsive hero. |
| Example article page | PASS | Built, 200, article element, heading hierarchy, Article JSON-LD, responsive image and internal links. |
| 404 | PASS | Unknown path returns 404 with expected content and home link. |
| Metadata/canonical/basic structured data | PARTIAL | Output structure is present, but documented `.env` configuration does not work, default origin is localhost, and most properties are untested. |
| Responsive local imagery | PASS | Local `astro:assets`; WebP variants; `srcset`, `sizes`, width/height and alt text; eager hero and lazy article behavior. |
| Minimal client JavaScript | PASS | No JS output and no framework integration/runtime. |
| Playwright desktop + mobile QA | PARTIAL | Four logical tests × two projects pass only with an undocumented agent-mode override; stale-server false PASS is confirmed. |
| Root `check`/`build`/`test`/`qa` commands | PARTIAL | `check` and `build` pass; ordinary `test` and `qa` fail in Codex. Failure propagation itself works. |
| Architecture documentation | PARTIAL | Correct package map and future-scope separation; connected-flow and test-proof wording overstate reality and omit agent-mode behavior. |
| Repository `AGENTS.md` | PARTIAL | Strong technology/minimalism rules; missing explicit coding-agent write allowlist and test/config deny-list. |
| No premature infrastructure/frameworks | PASS | No server, DB, queue, auth, dashboard, deploy target, or UI framework was introduced. |
| Later-stage systems listed as out of scope | NOT APPLICABLE | Their absence is intentional and was not penalized. |

## 6. Test coverage matrix

The reported eight tests are exactly four logical tests multiplied by two Chromium projects (`desktop` 1280×800 and an iPhone-sized `mobile` 390×844 viewport with DPR 3). They are not eight independent logical behaviors.

| Requirement | Existing test / assertion | Strength of proof | Gap |
| --- | --- | --- | --- |
| Homepage load | `expectOk("/")`; response status `< 400` | Moderate | Wording says 2xx but assertion is only `<400`; no expected title or body identity. |
| Homepage exactly one H1 | `locator("h1").toHaveCount(1)` | Strong for count | Does not prove meaningful H1 text. |
| Main Services navigation | Click named nav link; URL must end `/services/example`; destination has one H1 | Strong for this link | Does not verify response status or all nav/footer links. |
| Homepage/page console errors | Page and console listeners; exact empty array | Strong for explicit errors during observed navigation | Applied to homepage, service, article only; not 404; failed resources are browser-behavior dependent. |
| Service page | Status `<400`, title regex, one H1 | Moderate/strong | No exact title uniqueness, description, canonical, schema, or H1 content. |
| Service CTA | Named link `Start at our homepage` visible | Strong for existence/visibility | CTA is not clicked; href itself is not asserted. |
| Service Home navigation | Click header Home; URL ends `/` | Strong for this link | Does not prove the CTA destination. |
| Article content | Status, H1 count, visible `article`, expected text | Strong basic identity | No exact title/meta/heading sequence/date/image assertion. |
| Article JSON-LD | Script text contains `"@type":"Article"` | Weak/moderate | JSON is not parsed; required fields and URL correctness are not asserted. |
| Article internal link | Click named service link; assert target URL | Strong for this link | Homepage link and other internal links are not exercised. |
| 404 | Exact 404 status, H1 `404`, visible home link | Strong basic 404 proof | Home link is not clicked; no console watcher, metadata, or noindex behavior. |
| Desktop/mobile | Same suite runs in both projects | Moderate | Proves two layouts are operable, not touch behavior, overflow, focus visibility, or accessibility. |
| Screenshots | Full-page homepage/service PNG writes | Weak as an assertion | No existence assertion or visual comparison; article/404 have no screenshot. |
| Titles/descriptions/canonicals/OG | None, except service title regex | None | Broken canonicals can pass all 8 tests. |
| LocalBusiness/Service schemas | None | None | Only Article type substring is checked. |
| Responsive image contract | None | None | No test for local URL, WebP, `srcset`, `sizes`, dimensions, alt, or loading policy. |
| Accessibility | None | None | Semantic manual inspection only; no automated regression gate. |

## 7. Mutation test results

All source mutations were made one at a time in a disposable worktree and restored to `HEAD` between tests. `ASTRO_PREVIEW_BACKGROUND=0` was supplied so the mutation suite could reach the browser; that is diagnostic only, not a repository fix.

| Mutation | Expected | Actual | Caught by | Verdict |
| --- | --- | --- | --- | --- |
| A1. Change shared Hero H1 to a `div`; pristine baseline preview deliberately left on port 4321 | QA non-zero | `pnpm qa` exit 0; 8/8 passed against the other worktree | Nothing; `reuseExistingServer` attached to pristine server | **FAIL — confirmed false confidence** |
| A2. Same missing-H1 mutation with port free | QA non-zero | `pnpm test` exit 1; 4 failed, 4 passed | Homepage and service H1 count, both projects | PASS when correct build is served; message clearly reported expected 1/received 0. |
| B. Header Services target changed to `/services/broken` | QA non-zero | Exit 1; 2 failed | Homepage nav test, both projects | PASS; received URL shown clearly. |
| C. Service-page CTA removed | QA non-zero | Exit 1; 2 failed | Service CTA visibility test, both projects | PASS; missing named link shown clearly. |
| D. Inline `console.error("AUDIT_MUTATION")` on homepage | QA non-zero | Exit 1; 4 failed | Homepage test and service test after navigating Home, both projects | PASS; exact console payload shown. |
| E. Article service link changed to `/services/broken` | QA non-zero | Exit 1; 2 failed | Article link test, both projects | PASS; expected and received URLs shown. |
| F. 404 H1 changed from `404` to `Not Found` | QA non-zero | Exit 1; 2 failed | 404 content test, both projects | PASS; exact text mismatch shown. |
| G. All Layout canonicals forced to homepage | QA non-zero because per-page canonical is an explicit requirement | Exit 0; 8/8 passed | Nothing | **FAIL — SEO requirement is not tested** |

The assertion code is generally good at detecting the behaviors it names. The dominant risk is test-target ownership and untested acceptance criteria, not weak syntax in the focused assertions.

## 8. Findings

### FND-001 — P1 — Agent-mode QA cannot run

- **Category:** reproducibility / QA effectiveness
- **Files/lines:** `sites/starter/playwright.config.ts:34-39`; `sites/starter/package.json:9-11`; `package.json:11-12`
- **Evidence:** Plain `pnpm test` and `pnpm qa` both exited 1 with `Process from config.webServer exited early`. Astro 7.2.9 detected the Codex environment, spawned `astro preview --json` detached, exited its parent command, and left a background process. With `ASTRO_PREVIEW_BACKGROUND=0`, 8/8 passed. Astro documents that since 7.2.0 `astro preview` auto-backgrounds in detected AI-agent environments and documents the opt-out: <https://docs.astro.build/en/guides/build-with-ai/#background-mode>.
- **Expected:** Required root QA runs non-interactively inside the PR #2 Codex environment and owns the lifetime of its preview process.
- **Actual:** The exact target environment breaks the unmodified command before any browser test runs and can leave an orphan preview.
- **Why it matters:** PR #2's executor cannot use this required gate as written, so no autonomous result can be trusted or classified as PASS.
- **Minimal recommended fix:** Set `ASTRO_PREVIEW_BACKGROUND: "0"` in Playwright `webServer.env` (cross-platform) or use an equally explicit foreground preview command; verify startup and cleanup under Codex.
- **Confidence:** High — reproduced twice and isolated with the documented override.

### FND-002 — P1 — QA can silently test another worktree and falsely pass

- **Category:** QA effectiveness / hidden coupling / PR #2 readiness
- **Files/lines:** `sites/starter/playwright.config.ts:15,34-38`
- **Evidence:** A pristine detached worktree preview listened on fixed port 4321. In a second worktree, Hero's H1 was changed to a `div`. `pnpm qa` checked and built the mutated source, then reused the pristine server because `reuseExistingServer: !process.env.CI`; it exited 0 with 8/8 passed. After stopping the pristine server, the identical mutation caused four targeted H1 failures.
- **Expected:** QA tests the current worktree's current build or fails closed.
- **Actual:** Any responsive server at the shared port can become the test target in non-CI runs.
- **Why it matters:** PR #2 is explicitly worktree-based. Sequential or concurrent agents can certify broken patches by observing an unrelated baseline, which invalidates change acceptance and patch generation.
- **Minimal recommended fix:** Disable server reuse for QA and make the preview target owned by the test process. For concurrent worktrees, allocate/configure a unique port and pass the same value to `baseURL`, webServer URL, and preview. At minimum, collision must fail rather than reuse.
- **Confidence:** High — direct false-PASS mutation evidence.

### FND-003 — P1 — Documented canonical configuration does not work

- **Category:** actual defect / SEO / documentation / reproducibility
- **Files/lines:** `README.md:59-63`; `.env.example:1-3`; `sites/starter/astro.config.ts:4-7`
- **Evidence:** A root `.env` containing `PUBLIC_SITE_URL=https://root-env.audit.example` produced `http://localhost:4321/` in built canonicals. A site-local `.env` also had no effect. Only a shell-exported `PUBLIC_SITE_URL=... pnpm build` produced the requested origin. Ordinary `pnpm build` therefore emits localhost canonical, OG URL, and JSON-LD identifiers.
- **Expected:** Following the README's copy-`.env.example` procedure controls canonical origin, or a production build fails clearly when the required origin is absent.
- **Actual:** The config reads `process.env` before Astro/Vite `.env` loading makes that value available; the documented procedure gives false assurance.
- **Why it matters:** Autonomous QA can pass a site whose canonical identity points to localhost. Fixing this after generated sites proliferate is materially more expensive.
- **Minimal recommended fix:** Choose one supported configuration path, load it explicitly in `astro.config.ts` (with a clearly defined env directory), document the exact file location, and add a build/render assertion using a non-local origin. Fail closed for release-mode output if appropriate when the origin is absent.
- **Confidence:** High — root file, site file, and shell environment were tested independently.

### FND-004 — P1 — QA does not prove several explicit immutable site requirements

- **Category:** missing test coverage / documentation problem
- **Files/lines:** `sites/starter/tests/qa.spec.ts:34-109`; `docs/architecture.md:32-37,46-51`; `AGENTS.md:24-32`
- **Evidence:** Forcing every Layout canonical to `/` still produced 8/8 passing tests. No test asserts meta descriptions, per-page canonicals, OG URLs, LocalBusiness/Service schema, image output, or accessibility. Only the service title is asserted, and only Article `@type` is substring-checked. Architecture wording says the suite asserts "correct titles" and "zero page/console errors" generally, but the 404 does not attach the error watcher and most titles are not checked.
- **Expected:** The independent QA outside the coding agent's write scope proves the high-value requirements the autonomous agent is instructed to preserve.
- **Actual:** A page can violate canonical/metadata requirements and still receive a green suite.
- **Why it matters:** PR #2 will treat this suite as an acceptance oracle. Untested agent instructions are advisory, not an independent gate.
- **Minimal recommended fix:** Add narrow rendered-output assertions for unique title/description, expected canonical origin/path, parsed required JSON-LD fields, one H1, internal target status, and responsive image attributes. Keep the suite small; do not add a framework.
- **Confidence:** High — source matrix plus passing canonical mutation.

### FND-005 — P1 — `SiteTask` is too ambiguous for a safe executor boundary

- **Category:** architectural risk / contract quality
- **Files/lines:** `packages/contracts/src/site-task.ts:6-25`; `packages/contracts/src/fixtures.ts:4-13`; `docs/architecture.md:13-19,61-67`
- **Evidence:** The compiler accepted a `SiteTask` with `siteId: "../../outside-worktree"`, `page.type: "homepage"`, an absolute cross-origin URL with query/fragment as `slug`, empty title/description, duplicate arbitrary `sections: ["unknown", "unknown"]`. `siteId` has no documented mapping, slug's comment is not enforced or normalized, page type has no relationship to slug/schema, and section identifiers have no vocabulary or semantics. The fixture's title also does not establish whether `title` means H1, `<title>`, or both.
- **Expected:** Two independent executors can resolve the same task to the same allowed site, route, basic page semantics, and bounded section plan.
- **Actual:** Legitimate TypeScript values admit incompatible and unsafe interpretations.
- **Why it matters:** In PR #2 these fields influence worktree selection, file targets, prompts, routes, and generated source. Ambiguity can become path escape, inconsistent output, or irreproducible patch scope.
- **Minimal recommended fix:** Before PR #2 execution, define `siteId` as an allowlisted logical identifier (never a raw path), define normalized origin-relative slug rules and page-type coherence, narrow/define section identifiers and duplicate/order semantics, and clarify title/H1 metadata behavior. Add runtime validation at the external JSON trust boundary in PR #2 using the smallest suitable mechanism; PR #1 does not need a runtime schema library by default.
- **Confidence:** High for ambiguity and accepted values; impact depends on PR #2 mapping implementation.

### FND-006 — P1 — Future coding-agent scope does not protect the acceptance oracle

- **Category:** architectural risk / agent governance / PR #2 readiness
- **Files/lines:** `AGENTS.md:34-42`; `docs/architecture.md:61-67`
- **Evidence:** `AGENTS.md` says to change only files a SiteTask implies, but does not define an allowlist, forbid changes to `sites/starter/tests`, Playwright config, root scripts, manifests/lockfile, or `AGENTS.md`, or require QA to run in a separate trusted context. PR #2 documentation merely says the executor modifies a site repository and the existing QA runs afterward.
- **Expected:** The coding agent cannot weaken or replace the tests/configuration used to accept its own patch, and changed-file detection fails closed outside the authorized site source scope.
- **Actual:** The policy boundary exists only as ambiguous prose and permits self-modification of the oracle by interpretation.
- **Why it matters:** An autonomous agent can accidentally or deliberately make its own result green. This is one of the highest-cost boundaries to retrofit after executor behavior is established.
- **Minimal recommended fix:** Add a concise SiteTask rule: initial coding-agent writes are limited to the authorized `sites/starter/src/**` target (or an equally explicit task-derived allowlist); tests, QA config, package manifests/lockfile, root scripts, Git metadata, and policy files are deny-listed. Enforce the same list in PR #2 changed-file validation; do not rely on prompt text alone.
- **Confidence:** High — policy absence is directly observable.

### FND-007 — P2 — Node prerequisite is broader than the resolved toolchain supports

- **Category:** documentation / reproducibility
- **Files/lines:** `README.md:10-13`; `package.json:1-14`
- **Evidence:** README permits all Node 22 versions (`22+`), while resolved `astro@7.2.9` declares Node `>=22.12.0`. The root has no `engines`, `.node-version`, or `.nvmrc` to make that minimum machine-readable.
- **Expected:** A fresh engineer is directed to a supported Node version before install/check/build.
- **Actual:** Node 22.0–22.11 satisfies the README but not Astro's engine contract.
- **Why it matters:** This creates avoidable machine-specific install/build failures.
- **Minimal recommended fix:** State and declare `>=22.12.0` (or the deliberately supported exact line) in README and root package metadata; no version manager dependency is required.
- **Confidence:** High.

### FND-008 — P2 — Secret-file ignore coverage is incomplete

- **Category:** security hygiene / repository hygiene
- **Files/lines:** `.gitignore:13-16`
- **Evidence:** `.env` and `.env.production` are ignored, but common Astro/Vite variants such as `.env.local`, `.env.development`, `.env.development.local`, and package-local equivalents are not. No actual secret was found in tracked source/history, and `.env.example` contains only a placeholder.
- **Expected:** Common local environment files are ignored while `.env.example` remains trackable.
- **Actual:** A normal local secret file can appear in Git status and be committed accidentally.
- **Why it matters:** Autonomous execution increases the value of a simple deny-by-default secret-file guardrail.
- **Minimal recommended fix:** Ignore `.env*` at all workspace levels and explicitly unignore `.env.example` (and any deliberately tracked examples).
- **Confidence:** High.

### FND-009 — P2 — Playwright pin rationale is inaccurate

- **Category:** documentation / dependency hygiene
- **Files/lines:** `README.md:21-33`; `sites/starter/package.json:19-23`
- **Evidence:** The repo resolves `@playwright/test@1.61.1` and the suite explicitly forces Chromium. README says 1.62 dropped Chromium support for macOS 13. Official Playwright 1.62 release notes do not state that; the documented macOS 13 removal was for WebKit in an earlier release, not Chromium. Fresh Playwright 1.61 Chromium bootstrap and execution succeeded on this macOS 13.7.8 x86_64 host. See <https://playwright.dev/docs/release-notes#version-162> and the macOS/WebKit note under <https://playwright.dev/docs/release-notes#version-158>.
- **Expected:** A compatibility pin has an accurate browser/host rationale and an explicit reassessment condition.
- **Actual:** The stated rationale names the wrong browser/version boundary and is unsupported by current official notes.
- **Why it matters:** Incorrect pin lore becomes a hidden constraint and can block legitimate Linux/host maintenance. The pin itself did not break Linux metadata and is not a defect merely because a newer version exists.
- **Minimal recommended fix:** Correct the reason using a reproducible issue/reference or remove the unsupported explanation. Retain or change the pin only based on verified host behavior, not recency.
- **Confidence:** High for documentation mismatch; Linux execution was not run in this macOS audit.

### FND-010 — P3 — Unused JavaScript placeholder generator contradicts policy

- **Category:** dead/unnecessary code / policy coherence
- **Files/lines:** `sites/starter/scripts/generate-placeholders.mjs:1-73`; `AGENTS.md:8-14`
- **Evidence:** No package script or source imports the generator; all three generated PNGs are already tracked. It is JavaScript and is not checked by the TypeScript-only gate.
- **Expected:** Retained tooling is necessary, discoverable, and follows the repository's language rule.
- **Actual:** A one-off untyped generator remains as dead operational surface.
- **Why it matters:** Low immediate risk, but it weakens the credibility of agent rules.
- **Minimal recommended fix:** Remove it if regeneration is not a supported workflow. If regeneration is required, convert it to TypeScript, expose one documented script, and include it in checking.
- **Confidence:** High.

### FND-011 — P3 — Missing favicon produces a browser console/resource error

- **Category:** site polish / test coverage
- **Files/lines:** `sites/starter/src/layouts/Layout.astro:21-34`; no favicon asset is tracked
- **Evidence:** Manual real-browser inspection reported `Failed to load resource ... /favicon.ico` and direct request returned 404. The repository's pinned headless suite did not request/report it, so its console watcher stayed green.
- **Expected:** A production-oriented starter does not request a missing default asset.
- **Actual:** Some browser modes request an absent favicon and log an error.
- **Why it matters:** Low risk; it adds avoidable noise and demonstrates browser-dependent limits of console-only resource detection.
- **Minimal recommended fix:** Add a small local favicon and explicit `<link rel="icon">`, or otherwise make the intended icon behavior explicit.
- **Confidence:** High on this browser/preview combination.

## 9. Hidden assumptions

| Assumption | Status / risk |
| --- | --- |
| AI-agent detection does not alter Astro process behavior | False. Astro 7.2 changes preview to detached background mode; ordinary QA fails. |
| Port 4321 is free and belongs to the current worktree | False and dangerous. Existing servers are reused locally, producing a demonstrated false PASS. |
| `CI` is always set during autonomous QA | Not established. PR #2 local worktree execution is exactly where it may be absent. Even CI mode would fail on a port collision rather than allocate ownership. |
| Root `.env` loads `PUBLIC_SITE_URL` into Astro config | False in the tested setup. Site-local `.env` also did not populate `process.env` for config evaluation. |
| Omitting `PUBLIC_SITE_URL` is safe | Only for local preview. It emits localhost identity into static output and no gate distinguishes local from releasable output. |
| Node 22 means any Node 22 release | False for resolved Astro; actual minimum is 22.12.0. |
| Playwright browser already exists | Documented bootstrap addresses this. A fresh isolated cache download and test passed. Network is still required for first bootstrap. |
| pnpm package store is populated | Online frozen install reused the store; offline install passed only because this host had all artifacts. Not a repository guarantee. |
| macOS 13 requires a Chromium pin at Playwright 1.61 | Unsupported by cited release notes; the known removal concerns WebKit. |
| Linux compatibility is proven by macOS QA | Not proven. Lock metadata contains Linux binaries and no macOS path is hardcoded, but no Linux execution occurred. |
| Working tree starts clean | False in the operator's primary checkout due to pre-existing PR #2 work. Detached baseline worktrees were clean. |
| Coding agent will infer that tests/config are immutable | Unsafe. Neither policy nor PR #1 enforcement defines that boundary. |
| `siteId` and slug are benign identifiers | Unsafe before validation/mapping; current type accepts path-like and cross-origin strings. |
| JSON-LD inputs remain trusted source literals | True in PR #1 only. Before external JSON is accepted, validate size/characters and serialize so `</script>`-like content cannot break out of the JSON-LD script. |
| Current date does not affect output | Footer uses `new Date().getFullYear()`. This is acceptable for the demo but prevents byte-identical HTML across year boundaries. |

## 10. Dependency review

Resolved versions are from the frozen lockfile.

| Workspace | Direct dependency | Resolved | Used / justified? |
| --- | --- | ---: | --- |
| `apps/factory` | `@factory/contracts` | workspace link | Yes — imported by CLI; proves package boundary. |
| `apps/factory` | `@types/node` | 26.3.0 | Yes — Node runtime/global and JSON-module typing for CLI/tooling. |
| `apps/factory` | `tsx` | 4.23.12 | Yes — executes the non-emitted TypeScript CLI. |
| `apps/factory` | `typescript` | 5.9.3 | Yes — package-local strict check. |
| `packages/contracts` | `typescript` | 5.9.3 | Yes — package-local strict check. |
| `sites/starter` | `astro` | 7.2.9 | Yes — required site framework and build/check runtime. |
| `sites/starter` | `tailwindcss` | 4.3.3 | Yes — imported by global CSS. |
| `sites/starter` | `@tailwindcss/vite` | 4.3.3 | Yes — used by Astro Vite config. |
| `sites/starter` | `sharp` | 0.35.4 | Yes — required explicitly with strict package managers for Astro's default image service; official guidance: <https://docs.astro.build/en/reference/errors/missing-sharp/>. |
| `sites/starter` | `@astrojs/check` | 0.9.10 | Yes — provides `astro check`. |
| `sites/starter` | `@playwright/test` | 1.61.1 | Yes — browser QA; pin rationale needs correction, not automatic upgrade. |
| `sites/starter` | `@types/node` | 26.3.0 | Yes — config uses `process.env`. |
| `sites/starter` | `typescript` | 5.9.3 | Yes — Astro check peer/tooling. |

`pnpm why` found one TypeScript version and one Sharp version. Repeated TypeScript/@types declarations are intentional package-local declarations, not resolved duplication. No React/Vue/Svelte/UI runtime, runtime schema library, AstroWind-specific package, or undeclared imported transitive dependency was found. `pnpm audit` reported no known vulnerability on the audit date.

### Licensing and provenance

AstroWind's current upstream is MIT licensed with `Copyright (c) 2023 onWidget`; the license requires preservation of the notice for copies or substantial portions: <https://github.com/arthelokyo/astrowind/blob/main/LICENSE.md>. The audited repository has no license/provenance file and only one squashed foundation commit, so historical derivation cannot be reconstructed from Git.

Comparison against current AstroWind commit `62e877519fd27f0c8aba73db18d59d334910fadc` found no identical trimmed source/config line of 40 or more characters between the two trees; component structure and content are materially smaller and different. On available evidence, no concrete copied substantial portion—and therefore no concrete missing-notice violation—was established. If an older upstream revision was copied more directly, that provenance should be checked before distribution; this audit does not convert uncertainty into a finding.

## 11. Dead / unnecessary code

Concrete removable code only:

- `sites/starter/scripts/generate-placeholders.mjs` — not referenced by any manifest or source; it generated assets that are already committed. Remove it, or deliberately make it supported TypeScript tooling. See FND-010.

No other unused component, layout, route, dependency, duplicate config, generated tracked output, editor file, OS junk, or AstroWind subsystem was found. The second Astro build inside Playwright is redundant during `pnpm qa` but intentionally makes standalone `pnpm test` current; it should not be removed without preserving both entry-point guarantees.

## 12. PR #2 blockers

### Must fix before PR #2

1. Make Playwright's preview run in the foreground under detected AI agents and prove no orphan process remains.
2. Make QA own an unambiguous per-worktree server/port; never reuse an arbitrary local server. Re-run the missing-H1 mutation with another worktree active and require failure.
3. Make canonical origin configuration actually work, define local versus releasable defaults, and add a rendered canonical assertion with a non-local test origin.
4. Add the small set of high-value immutable QA assertions identified in FND-004; keep tests outside the coding-agent write scope.
5. Define `SiteTask` executor semantics and add PR #2 runtime validation for external JSON: exact task discriminator, allowlisted `siteId`, normalized origin-relative slug with no scheme/query/fragment/traversal, non-empty bounded title/description, coherent page type, known bounded section vocabulary/order/duplicates, payload size, and rejection of unknown/unsafe values.
6. Define and enforce the coding-agent changed-file allowlist/deny-list. The executor must independently reject edits to tests, QA/config, manifests/lockfile, policy files, Git metadata, or unrelated paths.

Before any task-derived text reaches Astro source or JSON-LD, PR #2 must also prevent source/prompt/script breakout, avoid interpolating raw values into shell commands, and correlate a structured result with the exact task/input and tested commit/patch.

### Can safely defer

- Codex execution architecture beyond the narrow PR #2 worktree/QA/result loop.
- Docker, databases, Mastra, queues, API server, dashboard, Cloudflare deployment, research/content pipelines, CMS, and multi-site management.
- Automated Lighthouse, advanced SEO automation, sitemap/Search Console/DataForSEO, and a broad design system.
- Automated accessibility dependency, provided manual semantics remain and high-value regressions are covered proportionately.
- Favicon polish and the unused placeholder generator cleanup, though both are cheap.
- Playwright upgrade; correct the unsupported rationale first, then change versions only with cross-host evidence.

## 13. Pareto remediation plan

1. **Own the QA server.** Configure foreground Astro preview in agent mode, disable arbitrary reuse, and use a collision-safe per-worktree port. Add startup/cleanup verification.
2. **Make SEO identity hermetic.** Load one documented origin source explicitly, fail closed where appropriate, and assert rendered canonical/description/JSON-LD fields under a non-local fixture origin.
3. **Protect the oracle.** Put tests/config/manifests/policy outside the coding-agent write allowlist and enforce changed-file validation in PR #2, not only in prompts.
4. **Tighten SiteTask semantics at the boundary.** Clarify identifiers/route/sections now; implement small runtime validation and safe mapping before accepting external JSON.
5. **Close the highest-value test gaps.** Add concise table-driven rendered checks for each route, exhaustive intended internal links, core schemas, and responsive image attributes; retain the mutation set as acceptance evidence.
6. **Correct reproducibility/security documentation.** State Node >=22.12, fix `.env` and Playwright wording, ignore `.env*` except examples, and describe the current two-rail architecture honestly.

No broad refactor, new UI framework, server, database, queue, or generic executor abstraction is required to close these findings.

## 14. Final gate

### Is PR #1 a trustworthy immutable baseline for PR #2?

## YES, AFTER LISTED FIXES

The codebase is small, coherent, and technically recoverable. Its workspace, static-site, component, image, dependency, and focused assertion foundations are sound. It is not trustworthy *as committed* because the required gate fails in the future executor's environment and, under plausible multi-worktree state, can return a false PASS against the wrong build. Canonical configuration/coverage and the autonomous write/task boundaries also need to be made explicit before increasing agent authority.

After all P1 items are fixed, acceptance requires a fresh detached clean checkout, frozen install, isolated browser bootstrap or declared cache, individual root commands with exits, full `pnpm qa` under Codex without overrides, clean Git state, the complete mutation matrix (including concurrent-worktree stale-server and broken-canonical cases), and an independent review of the final diff. Until then, do not treat `3e28370` as immutable and do not start autonomous PR #2 execution.
