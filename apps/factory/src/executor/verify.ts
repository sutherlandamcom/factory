import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SiteTask, TaskVerification } from "@factory/contracts";
import { createTaskQaSpec } from "./task-qa.js";

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const radix = normalized.startsWith("#x") ? 16 : 10;
    const raw = normalized.slice(radix === 16 ? 2 : 1);
    const codePoint = Number.parseInt(raw, radix);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function normalize(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(attributePattern)) {
    result.set(match[1]!.toLowerCase(), decodeHtml(match[2] ?? match[3] ?? ""));
  }
  return result;
}

function openingTags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((match) => match[0]);
}

function fail(requirement: string, expected: string, actual: string): TaskVerification {
  return { passed: false, details: `requirement=${requirement} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}` };
}

/** Dependency-free semantic sanity checks over fresh Astro build output. */
export async function verifyCreatePage(
  worktreePath: string,
  task: SiteTask,
): Promise<TaskVerification> {
  const slugPath = task.page.slug.replace(/^\//, "");
  const htmlPath = path.join(worktreePath, "sites", "starter", "dist", ...slugPath.split("/"), "index.html");
  if (!existsSync(htmlPath)) {
    return fail("route", `sites/starter/dist/${slugPath}/index.html`, "missing");
  }

  const html = await readFile(htmlPath, "utf8");
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const visibleHtml = withoutComments.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const expected = createTaskQaSpec(task);

  const titles = [...withoutComments.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((match) => normalize(match[1]!));
  if (titles.length !== 1) return fail("title-count", "1", String(titles.length));
  if (titles[0] !== expected.documentTitle) return fail("title", expected.documentTitle, titles[0]!);

  const headings = [...visibleHtml.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) => normalize(match[1]!));
  if (headings.length !== 1) return fail("h1-count", "1", String(headings.length));
  if (headings[0] !== task.page.title) return fail("h1", task.page.title, headings[0]!);

  const descriptions = openingTags(withoutComments, "meta")
    .map(attributes)
    .filter((attrs) => attrs.get("name")?.toLowerCase() === "description")
    .map((attrs) => attrs.get("content") ?? "");
  if (descriptions.length !== 1) return fail("description-count", "1", String(descriptions.length));
  if (normalize(descriptions[0]!) !== task.page.description) {
    return fail("description", task.page.description, normalize(descriptions[0]!));
  }

  const canonicals = openingTags(withoutComments, "link")
    .map(attributes)
    .filter((attrs) => attrs.get("rel")?.toLowerCase().split(/\s+/).includes("canonical"))
    .map((attrs) => attrs.get("href") ?? "");
  if (canonicals.length !== 1) return fail("canonical-count", "1", String(canonicals.length));
  if (canonicals[0] !== expected.canonicalUrl) return fail("canonical", expected.canonicalUrl, canonicals[0]!);

  return {
    passed: true,
    details: `route=${expected.route} semantic title, H1, description, and canonical checks passed`,
  };
}
