import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { SiteProfile, SiteIdentity } from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import { projects, sites, projectInputSnapshots } from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { loadWorktreeSiteProfile } from "../executor/site-profile.js";

export const SITE_BINDING_PATH = "sites/starter/project-site-binding.json";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const projectSiteBindingSchema = z.object({
  version: z.literal("project-site-binding-v1"),
  projectKey: z.string().min(1).max(100),
  siteKey: z.string().min(1).max(100),
  profileDigest: digest,
  acceptedSiteIdentityDigest: digest,
  informationalConversion: z.object({ acceptedInputDigest: digest, reason: z.string().min(1).max(1000) }).strict().optional(),
  delivery: z.object({
    workerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    productionUrl: z.string().url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
    }),
  }).strict(),
}).strict();
export type ProjectSiteBinding = z.infer<typeof projectSiteBindingSchema>;
export interface ProjectSiteContext {
  projectKey: string;
  siteKey: string;
  acceptedSiteIdentity: SiteIdentity;
}

export async function loadProjectSiteBinding(repoRoot: string, profile: SiteProfile, context: Omit<ProjectSiteContext, "siteKey"> & { siteKey?: string }) {
  try {
    const binding = projectSiteBindingSchema.parse(JSON.parse(await readFile(path.join(repoRoot, SITE_BINDING_PATH), "utf8")));
    if (binding.projectKey !== context.projectKey || (context.siteKey !== undefined && binding.siteKey !== context.siteKey) ||
        binding.profileDigest !== deterministicDigest(profile) ||
        binding.acceptedSiteIdentityDigest !== deterministicDigest(context.acceptedSiteIdentity) ||
        profile.siteName !== context.acceptedSiteIdentity.siteName ||
        profile.language !== context.acceptedSiteIdentity.language) {
      throw new Error("Project, site, accepted identity and trusted profile must match exactly.");
    }
    return { binding, bindingDigest: deterministicDigest(binding) };
  } catch (error) {
    throw new FactoryError("production_authority_stale", `Project/site binding is not configured or no longer matches. Provision ${SITE_BINDING_PATH} in this project's isolated worktree; proposed domains are not authorization. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Trusted shared boundary; browser input cannot supply or override this configuration. */
export async function requireProjectSiteAuthority(db: FactoryDb, repoRoot: string, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  const [snapshot] = await db.select().from(projectInputSnapshots).where(eq(projectInputSnapshots.projectId, projectId))
    .orderBy(desc(projectInputSnapshots.version)).limit(1);
  if (!project || !snapshot) throw new FactoryError("production_authority_stale", "Project/site binding requires current accepted project inputs.");
  const profile = await loadWorktreeSiteProfile(repoRoot);
  const payload = snapshot.payload as { siteIdentity: SiteIdentity };
  const raw = await loadProjectSiteBinding(repoRoot, profile, {
    projectKey: project.key,
    acceptedSiteIdentity: payload.siteIdentity,
  });
  const [site] = await db.select().from(sites).where(and(eq(sites.projectId, projectId), eq(sites.key, raw.binding.siteKey)));
  if (!site || site.cloudflareWorkerName !== raw.binding.delivery.workerName || site.productionUrl !== raw.binding.delivery.productionUrl) {
    throw new FactoryError("delivery_target_unconfigured", "Registered site must explicitly match the trusted project/site binding and delivery destination.");
  }
  return { ...raw, profile, site, snapshot };
}
