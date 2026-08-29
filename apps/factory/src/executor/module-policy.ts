import type { SiteTask } from "@factory/contracts";

export type ModuleId =
  | "contracts"
  | "control-plane"
  | "site-source"
  | "site-configuration"
  | "quality-oracle"
  | "repository-policy";

export interface FactoryModule {
  id: ModuleId;
  ownedPaths: readonly string[];
  protected: boolean;
  ordinaryTaskWritable: boolean;
}

/** Only modules that exist in the current repository are registered. */
export const MODULE_REGISTRY: readonly FactoryModule[] = Object.freeze([
  { id: "contracts", ownedPaths: ["packages/contracts/"], protected: true, ordinaryTaskWritable: false },
  { id: "control-plane", ownedPaths: ["apps/factory/"], protected: true, ordinaryTaskWritable: false },
  { id: "site-source", ownedPaths: ["sites/starter/src/"], protected: false, ordinaryTaskWritable: true },
  {
    id: "site-configuration",
    ownedPaths: ["sites/starter/astro.config.ts", "sites/starter/package.json", "sites/starter/tsconfig.json"],
    protected: true,
    ordinaryTaskWritable: false,
  },
  {
    id: "quality-oracle",
    ownedPaths: ["sites/starter/tests/", "sites/starter/playwright.config.ts"],
    protected: true,
    ordinaryTaskWritable: false,
  },
  {
    id: "repository-policy",
    ownedPaths: ["AGENTS.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json"],
    protected: true,
    ordinaryTaskWritable: false,
  },
]);

export interface TaskWritePolicy {
  taskType: SiteTask["type"];
  readableModules: readonly ModuleId[];
  writableModules: readonly ModuleId[];
  writablePaths: readonly string[];
}

export function createPageTargetPath(task: SiteTask): string {
  if (task.page.slug === "/") return "sites/starter/src/pages/index.astro";
  return `sites/starter/src/pages/${task.page.slug.slice(1)}.astro`;
}

/** READ MANY / WRITE FEW: task content cannot supply or widen these fields. */
export function deriveTaskWritePolicy(task: SiteTask): TaskWritePolicy {
  return Object.freeze({
    taskType: task.type,
    readableModules: Object.freeze(MODULE_REGISTRY.map((module) => module.id)),
    writableModules: Object.freeze(["site-source"] as const),
    writablePaths: Object.freeze([createPageTargetPath(task)]),
  });
}

export function policyAllowsWrite(policy: TaskWritePolicy, relativePath: string): boolean {
  return policy.writablePaths.includes(relativePath);
}

export function owningModules(relativePath: string): ModuleId[] {
  return MODULE_REGISTRY
    .filter((module) => module.ownedPaths.some((ownedPath) =>
      ownedPath.endsWith("/") ? relativePath.startsWith(ownedPath) : relativePath === ownedPath,
    ))
    .map((module) => module.id);
}
