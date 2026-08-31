import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { exampleSiteTask } from "@factory/contracts";
import { collectChanges, parseRawDiffZ } from "../src/executor/scope.js";
import { createPageTargetPath, deriveTaskWritePolicy } from "../src/executor/module-policy.js";
import { createWorktree, removeWorktree } from "../src/executor/worktree.js";
import { gitIn, makeTempRepo } from "./helpers.js";

const POLICY = deriveTaskWritePolicy(exampleSiteTask);

async function withWorktree(name: string, run: (repo: string, worktree: string) => Promise<void>) {
  const repo = await makeTempRepo();
  const worktree = await createWorktree(repo, gitIn(repo, ["rev-parse", "HEAD"]), name);
  try {
    await run(repo, worktree);
  } finally {
    await removeWorktree(repo, worktree);
  }
}

async function writeTarget(worktree: string, content = "---\n---\n<h1>Roof Repair</h1>\n") {
  const target = path.join(worktree, createPageTargetPath(exampleSiteTask));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

test("validated task derives exactly one create_page target", () => {
  assert.equal(createPageTargetPath(exampleSiteTask), "sites/starter/src/pages/services/roof-repair.astro");
  assert.equal(createPageTargetPath({ ...exampleSiteTask, page: { ...exampleSiteTask.page, type: "homepage", slug: "/" } }), "sites/starter/src/pages/index.astro");
  assert.equal(createPageTargetPath({ ...exampleSiteTask, page: { ...exampleSiteTask.page, slug: "/services/roof/repair" } }), "sites/starter/src/pages/services/roof/repair.astro");
  assert.equal(createPageTargetPath({ ...exampleSiteTask, page: { ...exampleSiteTask.page, type: "general", slug: "/about" } }), "sites/starter/src/pages/about.astro");
  assert.equal(createPageTargetPath({ ...exampleSiteTask, page: { ...exampleSiteTask.page, type: "general", slug: "/private-office/approach" } }), "sites/starter/src/pages/private-office/approach.astro");
});

test("hierarchical general scope accepts only its exact target", async () => {
  const task = {
    ...exampleSiteTask,
    page: { ...exampleSiteTask.page, type: "general" as const, slug: "/private-office/approach" },
  };
  const policy = deriveTaskWritePolicy(task);
  await withWorktree("scope-general-hierarchy", async (_repo, worktree) => {
    const target = path.join(worktree, createPageTargetPath(task));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "---\n---\n<h1>Approach</h1>\n");
    let result = await collectChanges(worktree, policy);
    assert.deepEqual(result.changedFiles, ["sites/starter/src/pages/private-office/approach.astro"]);
    assert.deepEqual(result.violations, []);

    await writeFile(path.join(worktree, "sites/starter/src/pages/private-office/other.astro"), "<h1>Sibling</h1>\n");
    result = await collectChanges(worktree, policy);
    assert.ok(result.violations.some((issue) => issue.startsWith("sites/starter/src/pages/private-office/other.astro:")));
  });
});

test("exact target regular file is accepted and patch is binary-safe", async () => {
  await withWorktree("scope-target", async (_repo, worktree) => {
    await writeTarget(worktree);
    const result = await collectChanges(worktree, POLICY);
    assert.deepEqual(result.changedFiles, [createPageTargetPath(exampleSiteTask)]);
    assert.deepEqual(result.violations, []);
    assert.match(result.patch, /Roof Repair/);
    assert.ok(result.rawEvidence.includes("\0"));
  });
});

test("unrelated source page is rejected for create_page", async () => {
  await withWorktree("scope-unrelated", async (_repo, worktree) => {
    await writeFile(path.join(worktree, "sites/starter/src/pages/index.astro"), "<h1>changed</h1>\n");
    const result = await collectChanges(worktree, POLICY);
    assert.ok(result.violations.some((value) => value.includes("path not authorized")));
  });
});

test("the authoritative TaskWritePolicy rejects every protected current module", async () => {
  await withWorktree("scope-protected-modules", async (_repo, worktree) => {
    const denied = [
      "sites/starter/src/components/Hero.astro",
      "apps/factory/src/executor/run.ts",
      "packages/contracts/src/site-task.ts",
      "sites/starter/tests/qa.spec.ts",
      "sites/starter/playwright.config.ts",
      "AGENTS.md",
    ];
    for (const relative of denied) {
      const file = path.join(worktree, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `protected mutation: ${relative}\n`);
    }
    const result = await collectChanges(worktree, POLICY);
    for (const relative of denied) {
      assert.ok(result.violations.some((value) => value.startsWith(`${relative}:`)), relative);
    }
  });
});

test("root-to-target rename evaluates both deletion and addition", async () => {
  await withWorktree("scope-rename-root", async (_repo, worktree) => {
    const target = path.join(worktree, createPageTargetPath(exampleSiteTask));
    await mkdir(path.dirname(target), { recursive: true });
    gitIn(worktree, ["mv", "package.json", createPageTargetPath(exampleSiteTask)]);
    const result = await collectChanges(worktree, POLICY);
    assert.deepEqual(result.changedFiles.sort(), ["package.json", createPageTargetPath(exampleSiteTask)].sort());
    assert.ok(result.violations.some((value) => value.startsWith("package.json:")));
  });
});

test("rename between explicitly allowed regular paths is represented as delete plus add", async () => {
  await withWorktree("scope-rename-allowed", async (_repo, worktree) => {
    const source = "sites/starter/src/pages/index.astro";
    const destination = "sites/starter/src/pages/renamed.astro";
    gitIn(worktree, ["mv", source, destination]);
    const result = await collectChanges(worktree, [source, destination]);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.changes.map((change) => change.status).sort(), ["A", "D"]);
  });
});

test("copy, deletion, and binary additions are evaluated without rename heuristics", async () => {
  await withWorktree("scope-copy", async (_repo, worktree) => {
    const target = createPageTargetPath(exampleSiteTask);
    await mkdir(path.dirname(path.join(worktree, target)), { recursive: true });
    await copyFile(path.join(worktree, "sites/starter/src/pages/index.astro"), path.join(worktree, target));
    const result = await collectChanges(worktree, POLICY);
    assert.deepEqual(result.violations, []);
    assert.equal(result.changes[0]?.status, "A");
  });

  await withWorktree("scope-delete", async (_repo, worktree) => {
    const homepageTask = { ...exampleSiteTask, page: { ...exampleSiteTask.page, type: "homepage" as const, slug: "/" } };
    gitIn(worktree, ["rm", "sites/starter/src/pages/index.astro"]);
    const result = await collectChanges(worktree, deriveTaskWritePolicy(homepageTask));
    assert.deepEqual(result.violations, []);
    assert.equal(result.changes[0]?.status, "D");
  });

  await withWorktree("scope-binary", async (_repo, worktree) => {
    await writeTarget(worktree, "\u0000\u0001\u0002binary");
    const result = await collectChanges(worktree, POLICY);
    assert.deepEqual(result.violations, []);
    assert.match(result.patch, /GIT binary patch/);
  });
});

test("symlinks to external and denied repository paths fail mechanically", async () => {
  for (const [name, target] of [["external", "/tmp/factory-synthetic-canary"], ["denied", "../../../../../package.json"]] as const) {
    await withWorktree(`scope-symlink-${name}`, async (_repo, worktree) => {
      const file = path.join(worktree, createPageTargetPath(exampleSiteTask));
      await mkdir(path.dirname(file), { recursive: true });
      await symlink(target, file);
      const result = await collectChanges(worktree, POLICY);
      assert.ok(result.violations.some((value) => value.includes("120000")));
      assert.ok(result.violations.some((value) => value.includes("not a regular file")));
    });
  }
});

test("executable and gitlink modes are rejected", async () => {
  await withWorktree("scope-executable", async (_repo, worktree) => {
    const target = await writeTarget(worktree);
    await chmod(target, 0o755);
    const result = await collectChanges(worktree, POLICY);
    assert.ok(result.violations.some((value) => value.includes("100755")));
  });

  await withWorktree("scope-gitlink", async (_repo, worktree) => {
    const target = createPageTargetPath(exampleSiteTask);
    const embedded = path.join(worktree, target);
    await mkdir(embedded, { recursive: true });
    gitIn(embedded, ["init", "-q"]);
    gitIn(embedded, ["config", "user.email", "test@factory.local"]);
    gitIn(embedded, ["config", "user.name", "Factory Test"]);
    await writeFile(path.join(embedded, "file.txt"), "embedded\n");
    gitIn(embedded, ["add", "file.txt"]);
    gitIn(embedded, ["commit", "-q", "-m", "embedded"]);
    const result = await collectChanges(worktree, POLICY);
    assert.ok(result.violations.some((value) => value.includes("160000")));
  });
});

test("NUL parser preserves spaces, Unicode, tabs, and newlines", () => {
  const paths = ["space name.astro", "café.astro", "tab\tname.astro", "line\nname.astro"];
  const raw = paths.map((file) => `:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0${file}\0`).join("");
  assert.deepEqual(parseRawDiffZ(raw).map((change) => change.path), paths);
});

test("staging remains evidence-only", async () => {
  await withWorktree("scope-no-commit", async (repo, worktree) => {
    const head = gitIn(repo, ["rev-parse", "HEAD"]);
    await writeTarget(worktree);
    await collectChanges(worktree, POLICY);
    assert.equal(gitIn(worktree, ["rev-parse", "HEAD"]), head);
  });
});

test("nested helper named dist/helper.ts or .factory/hidden.ts in source is staged and rejected by scope", async () => {
  await withWorktree("scope-nested-helper", async (_repo, worktree) => {
    await writeTarget(worktree);
    const nestedDistHelper = path.join(worktree, "sites", "starter", "src", "pages", "services", "dist", "helper.ts");
    await mkdir(path.dirname(nestedDistHelper), { recursive: true });
    await writeFile(nestedDistHelper, "export const helper = 'evil';\n");

    const nestedFactoryHelper = path.join(worktree, "sites", "starter", "src", "pages", "services", ".factory", "hidden.ts");
    await mkdir(path.dirname(nestedFactoryHelper), { recursive: true });
    await writeFile(nestedFactoryHelper, "export const hidden = 'secret';\n");

    const result = await collectChanges(worktree, POLICY);
    assert.ok(
      result.violations.some((v) => v.includes("sites/starter/src/pages/services/dist/helper.ts")),
      "nested dist helper must be flagged as scope violation",
    );
    assert.ok(
      result.violations.some((v) => v.includes("sites/starter/src/pages/services/.factory/hidden.ts")),
      "nested .factory helper must be flagged as scope violation",
    );
  });
});
