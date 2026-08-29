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
    "site-source",
    "site-configuration",
    "quality-oracle",
    "repository-policy",
  ]);
  assert.ok(!MODULE_REGISTRY.some((module) => /seo|research|content|deployment|persistence/.test(module.id)));
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

test("create_page cannot write protected or unrelated paths", () => {
  const policy = deriveTaskWritePolicy(exampleSiteTask);
  const denied = [
    "sites/starter/src/pages/index.astro",
    "sites/starter/src/components/Hero.astro",
    "apps/factory/src/executor/run.ts",
    "packages/contracts/src/site-task.ts",
    "sites/starter/tests/qa.spec.ts",
    "sites/starter/playwright.config.ts",
    "sites/starter/astro.config.ts",
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
  assert.equal(MODULE_REGISTRY.find((module) => module.id === "contracts")?.protected, true);
  assert.equal(MODULE_REGISTRY.find((module) => module.id === "contracts")?.ordinaryTaskWritable, false);
});
