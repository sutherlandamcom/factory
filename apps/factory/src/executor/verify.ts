import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { SiteTask, TaskVerification } from "@factory/contracts";

/**
 * Task-specific verification, owned by Factory and run against the
 * worktree's build output. Deterministic, no framework, unmodifiable by
 * Codex (it lives in apps/factory, outside the allowed change scope).
 *
 * create_page:
 * (a) the expected dist HTML exists for the slug
 * (b) it contains the SiteTask title
 * (c) the canonical link is present and matches the slug path
 */
export async function verifyCreatePage(
  worktreePath: string,
  task: SiteTask,
): Promise<TaskVerification> {
  const slugPath = task.page.slug.replace(/^\//, "");
  const htmlPath = path.join(
    worktreePath,
    "sites",
    "starter",
    "dist",
    ...slugPath.split("/"),
    "index.html",
  );

  if (!existsSync(htmlPath)) {
    return {
      passed: false,
      details: `expected built page missing: sites/starter/dist/${slugPath}/index.html`,
    };
  }

  const html = await readFile(htmlPath, "utf8");

  // 1. Verify title appears in page HTML
  if (!html.includes(task.page.title)) {
    return {
      passed: false,
      details: `built page sites/starter/dist/${slugPath}/index.html does not contain the SiteTask title "${task.page.title}"`,
    };
  }

  // 2. Verify canonical link is present and points to expected slug path
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (!canonicalMatch) {
    return {
      passed: false,
      details: `built page sites/starter/dist/${slugPath}/index.html missing canonical <link>`,
    };
  }

  const canonicalUrl = canonicalMatch[1]!;
  const expectedPath = task.page.slug === "/" ? "/" : `${task.page.slug}/`;
  if (!canonicalUrl.endsWith(expectedPath) && !canonicalUrl.endsWith(task.page.slug)) {
    return {
      passed: false,
      details: `canonical href "${canonicalUrl}" does not match expected slug path "${expectedPath}"`,
    };
  }

  return {
    passed: true,
    details: `sites/starter/dist/${slugPath}/index.html exists, contains title "${task.page.title}", and canonical URL is correct`,
  };
}
