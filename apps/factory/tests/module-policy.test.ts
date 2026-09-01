import assert from "node:assert/strict";
import test from "node:test";
import { exampleSiteTask, parseSiteTask } from "@factory/contracts";
import {
  MODULE_REGISTRY,
  createPageTargetPath,
  deriveTaskWritePolicy,
  owningModules,
  policyAllowsWrite,
} from "../src/executor/module-policy.js";

test("registry contains only current repository modules", () => {
  assert.deepEqual(MODULE_REGISTRY.map((module) => module.id), [
    "contracts",
    "control-plane",
    "persistence",
    "production-delivery",
    "site-intelligence",
    "models",
    "blueprint",
    "evals",
    "site-source",
    "site-configuration",
    "quality-oracle",
    "repository-policy",
  ]);
  assert.ok(!MODULE_REGISTRY.some((module) => /seo|research|content/.test(module.id)));
});

test("autonomy modules are protected and not ordinary-task writable", () => {
  for (const [id, ownedPath] of [
    ["models", "apps/factory/src/models/"],
    ["blueprint", "apps/factory/src/blueprint/"],
    ["evals", "apps/factory/src/evals/"],
  ] as const) {
    const module = MODULE_REGISTRY.find((entry) => entry.id === id);
    assert.ok(module, `${id} module must be registered`);
    assert.deepEqual(module.ownedPaths, [ownedPath]);
    assert.equal(module.protected, true);
    assert.equal(module.ordinaryTaskWritable, false);
    assert.deepEqual(owningModules(`${ownedPath}driver.ts`), [id]);
  }
});

test("site-intelligence module is protected and not ordinary-task writable", () => {
  const module = MODULE_REGISTRY.find((entry) => entry.id === "site-intelligence");
  assert.ok(module, "site-intelligence module must be registered");
  assert.deepEqual(module.ownedPaths, ["apps/factory/src/intelligence/"]);
  assert.equal(module.protected, true);
  assert.equal(module.ordinaryTaskWritable, false);
  assert.deepEqual(owningModules("apps/factory/src/intelligence/driver.ts"), ["site-intelligence"]);
});

test("create_page has READ MANY / WRITE ONE exact-page authority", () => {
  const policy = deriveTaskWritePolicy(exampleSiteTask);
  assert.equal(policy.writablePaths.length, 1);
  assert.equal(policy.writablePaths[0], createPageTargetPath(exampleSiteTask));
  assert.deepEqual(policy.writableModules, ["site-source"]);
  assert.equal(policy.readableModules.length, MODULE_REGISTRY.length);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.writablePaths));
});

test("flat and hierarchical general pages retain exact WRITE ONE authority", () => {
  for (const [slug, expected] of [
    ["/about", "sites/starter/src/pages/about.astro"],
    ["/private-office/approach", "sites/starter/src/pages/private-office/approach.astro"],
  ] as const) {
    const task = parseSiteTask({
      ...exampleSiteTask,
      page: { ...exampleSiteTask.page, type: "general", slug },
    });
    const policy = deriveTaskWritePolicy(task);
    assert.deepEqual(policy.writablePaths, [expected]);
    assert.equal(policyAllowsWrite(policy, expected), true);
    assert.equal(policyAllowsWrite(policy, "sites/starter/src/pages/private-office/index.astro"), false);
    assert.equal(policyAllowsWrite(policy, "sites/starter/src/pages/private-office/other.astro"), false);
    assert.equal(policyAllowsWrite(policy, "sites/starter/src/components/Hero.astro"), false);
  }
});

test("general page can never obtain homepage target sites/starter/src/pages/index.astro via /index", () => {
  assert.throws(
    () =>
      parseSiteTask({
        ...exampleSiteTask,
        page: { ...exampleSiteTask.page, type: "general", slug: "/index" },
      }),
    /reserved Astro directory segment/,
  );

  const homepageTask = parseSiteTask({
    ...exampleSiteTask,
    page: { ...exampleSiteTask.page, type: "homepage", slug: "/" },
  });
  const homepagePolicy = deriveTaskWritePolicy(homepageTask);
  assert.deepEqual(homepagePolicy.writablePaths, ["sites/starter/src/pages/index.astro"]);
  assert.equal(policyAllowsWrite(homepagePolicy, "sites/starter/src/pages/index.astro"), true);
});

test("create_page cannot write protected or unrelated paths", () => {
  const policy = deriveTaskWritePolicy(exampleSiteTask);
  const denied = [
    "sites/starter/src/pages/index.astro",
    "sites/starter/src/components/Hero.astro",
    "apps/factory/src/executor/run.ts",
    "apps/factory/src/persistence/schema.ts",
    "apps/factory/src/delivery/service.ts",
    "apps/factory/src/intelligence/driver.ts",
    "packages/contracts/src/site-task.ts",
    "sites/starter/tests/qa.spec.ts",
    "sites/starter/playwright.config.ts",
    "sites/starter/astro.config.ts",
    "sites/starter/wrangler.jsonc",
    "AGENTS.md",
    "package.json",
    "pnpm-lock.yaml",
  ];
  for (const file of denied) assert.equal(policyAllowsWrite(policy, file), false, file);
  assert.equal(policyAllowsWrite(policy, createPageTargetPath(exampleSiteTask)), true);
});

test("task-controlled input cannot declare or enlarge policy", () => {
  assert.throws(() => parseSiteTask({ ...exampleSiteTask, writablePaths: ["apps/factory/"] }));
  const changedContent = {
    ...exampleSiteTask,
    page: { ...exampleSiteTask.page, title: "apps/factory/", description: "packages/contracts/" },
  };
  assert.deepEqual(
    deriveTaskWritePolicy(changedContent).writablePaths,
    deriveTaskWritePolicy(exampleSiteTask).writablePaths,
  );
});

test("protected path ownership is separate from read and write authority", () => {
  assert.deepEqual(owningModules("packages/contracts/src/site-task.ts"), ["contracts"]);
  assert.deepEqual(owningModules("sites/starter/tests/qa.spec.ts"), ["quality-oracle"]);
  assert.deepEqual(owningModules("sites/starter/src/components/Hero.astro"), ["site-source"]);
  assert.deepEqual(owningModules("sites/starter/wrangler.jsonc"), ["production-delivery"]);
  assert.equal(MODULE_REGISTRY.find((module) => module.id === "contracts")?.protected, true);
  assert.equal(MODULE_REGISTRY.find((module) => module.id === "contracts")?.ordinaryTaskWritable, false);
});
