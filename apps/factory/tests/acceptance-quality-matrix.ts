import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SiteTask } from "@factory/contracts";
import { buildChildEnv } from "../src/executor/env.js";
import { runProcess } from "../src/executor/process.js";
import { createTaskQaSpec } from "../src/executor/task-qa.js";
import { createWorktree, removeWorktree } from "../src/executor/worktree.js";
import { gitIn } from "./helpers.js";

const task: SiteTask = {
  type: "create_page",
  siteId: "starter",
  page: {
    type: "service",
    slug: "/services/quality-matrix",
    title: "Quality Matrix Service",
    description: "A deterministic generated page used to verify Factory dynamic quality policy.",
    sections: ["hero", "faq", "cta"],
  },
};

function validPage(): string {
  return `---
import { Image } from "astro:assets";
import image from "../../assets/roof-repair.png";
const canonical = new URL(Astro.url.pathname, Astro.site ?? Astro.url.origin).href;
const jsonLd = { "@context": "https://schema.org", "@type": "Service", serviceType: "Quality Matrix Service", url: canonical };
---
<!doctype html>
<html lang="en">
  <head>
    <title>Quality Matrix Service | Summit Roofing Co.</title>
    <meta name="description" content="A deterministic generated page used to verify Factory dynamic quality policy." />
    <link rel="canonical" href={canonical} />
    <meta property="og:title" content="Quality Matrix Service | Summit Roofing Co." />
    <meta property="og:description" content="A deterministic generated page used to verify Factory dynamic quality policy." />
    <meta property="og:url" content={canonical} />
    <script type="application/ld+json" is:inline set:html={JSON.stringify(jsonLd)} />
  </head>
  <body>
    <main>
      <h1>Quality Matrix Service</h1>
      <p>This page contains enough meaningful supporting copy to satisfy the generated-page content policy reliably.</p>
      <a href="/">Return to the homepage</a>
      <details><summary>Frequently asked question</summary><p>A useful and deterministic answer.</p></details>
      <Image src={image} alt="A roofing professional completing a repair" widths={[480, 768]} sizes="(max-width: 768px) 100vw, 50vw" loading="eager" />
    </main>
  </body>
</html>
`;
}

const scenarios: Array<{ defect: string; gate: string; mutate: (source: string) => string; sections?: SiteTask["page"]["sections"] }> = [
  { defect: "no H1", gate: "h1-count", mutate: (s) => s.replace("<h1>Quality Matrix Service</h1>", "<div>Quality Matrix Service</div>") },
  { defect: "no meta description", gate: "description", mutate: (s) => s.replace('content="A deterministic generated page used to verify Factory dynamic quality policy." />\n    <link', 'content="" />\n    <link') },
  { defect: "missing required Open Graph metadata", gate: "og:title", mutate: (s) => s.replace(/    <meta property="og:title"[^\n]+\n/, "") },
  { defect: "malformed JSON-LD", gate: "json-ld-parse", mutate: (s) => s.replace("set:html={JSON.stringify(jsonLd)}", 'set:html={"{"}') },
  { defect: "missing required CTA", gate: "cta", mutate: (s) => s.replace('      <a href="/">Return to the homepage</a>\n', "") },
  { defect: "broken internal link", gate: "internal-link", mutate: (s) => s.replace('href="/"', 'href="/missing-quality-matrix-target"') },
  { defect: "console.error/runtime error", gate: "page-errors", mutate: (s) => s.replace("    </main>", '      <script is:inline>console.error("QUALITY_MATRIX_ERROR")</script>\n    </main>') },
  { defect: "missing meaningful image alt", gate: "image-alt", mutate: (s) => s.replace('alt="A roofing professional completing a repair"', 'alt=""') },
  { defect: "missing image dimensions", gate: "image-width", mutate: (s) => s.replace(/<Image src=\{image\}[^\n]+\/>/, '<img src="/favicon.svg" alt="Roof repair" srcset="/favicon.svg 1x" sizes="100vw" loading="eager" />') },
  { defect: "horizontal mobile overflow", gate: "horizontal-overflow", mutate: (s) => s.replace("    </main>", '      <div style="width:5000px">overflow</div>\n    </main>') },
  { defect: "duplicate H1", gate: "h1-count", mutate: (s) => s.replace("<h1>Quality Matrix Service</h1>", "<h1>Quality Matrix Service</h1><h1>Duplicate</h1>") },
  {
    defect: "effectively empty page body",
    gate: "meaningful-body",
    sections: ["hero"],
    mutate: (s) => s
      .replace(/      <p>This page[\s\S]*?<\/p>\n/, "")
      .replace(/      <a href="\/">[\s\S]*?<\/a>\n/, "")
      .replace(/      <details>[\s\S]*?<\/details>\n/, "")
      .replace(/      <Image[^\n]+\/>\n/, ""),
  },
];

async function main() {
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  const baseCommit = gitIn(repoRoot, ["rev-parse", "HEAD"]);
  const runId = `quality-matrix-${Date.now()}`;
  const worktree = await createWorktree(repoRoot, baseCommit, runId);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "factory-quality-matrix-"));
  const results: Array<{ defect: string; oldResult: "FALSE PASS"; newResult: "FAIL"; gate: string }> = [];

  try {
    const install = await runProcess("pnpm", ["install", "--offline", "--frozen-lockfile"], {
      cwd: worktree,
      env: buildChildEnv(),
      timeoutMs: 300_000,
    });
    assert.equal(install.exitCode, 0, install.stderr);

    const pagePath = path.join(worktree, "sites/starter/src/pages/services/quality-matrix.astro");
    await mkdir(path.dirname(pagePath), { recursive: true });

    for (const [index, scenario] of scenarios.entries()) {
      await writeFile(pagePath, scenario.mutate(validPage()), "utf8");
      const scenarioTask = scenario.sections
        ? { ...task, page: { ...task.page, sections: scenario.sections } }
        : task;
      const specPath = path.join(tempDir, `${index + 1}.json`);
      await writeFile(specPath, JSON.stringify(createTaskQaSpec(scenarioTask), null, 2), "utf8");
      const result = await runProcess(
        "pnpm",
        ["--filter", "@factory/site-starter", "exec", "playwright", "test", "tests/task-page.qa.spec.ts"],
        {
          cwd: worktree,
          env: buildChildEnv(process.env, {
            CI: "1",
            PUBLIC_SITE_URL: "https://test.example.com",
            FACTORY_TASK_QA_SPEC: specPath,
            FACTORY_QA_PORT: String(4400 + index),
          }),
          timeoutMs: 180_000,
        },
      );
      assert.notEqual(result.exitCode, 0, `${scenario.defect} unexpectedly passed dynamic QA`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, new RegExp(scenario.gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${scenario.defect} did not report ${scenario.gate}`);
      results.push({ defect: scenario.defect, oldResult: "FALSE PASS", newResult: "FAIL", gate: scenario.gate });
    }

    const artifactDir = path.join(repoRoot, ".factory", "acceptance");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "quality-matrix.json"),
      JSON.stringify({ baseCommit, falsePassesBefore: 12, falsePassesAfter: 0, results }, null, 2),
      "utf8",
    );
    console.table(results);
    console.log("12/12 defects rejected; false passes after remediation: 0");
  } finally {
    await removeWorktree(repoRoot, worktree);
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
