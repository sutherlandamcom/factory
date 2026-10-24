import { test, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const distDir = process.env.FACTORY_QA_ARTIFACT_DIR
  ? path.resolve(process.env.FACTORY_QA_ARTIFACT_DIR)
  : path.resolve(import.meta.dirname, "../dist");

function collectRoutes(): string[] {
  if (!existsSync(distDir)) return [];
  const routes: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
      else if (entry.name === "index.html") routes.push(prefix === "" ? "/" : prefix);
    }
  };
  walk(distDir, "");
  return routes.sort();
}

for (const route of collectRoutes()) {
  test(`keyboard: ${route} exposes every interactive element in DOM order`, async ({ page }) => {
    let isRedirectStub = false;
    try {
      const response = await page.request.get(route === "/" ? "/index.html" : route);
      const body = await response.text();
      isRedirectStub = /http-equiv="refresh"/i.test(body) && /name="robots" content="noindex"/i.test(body);
    } catch {
      isRedirectStub = false;
    }
    test.skip(isRedirectStub, `${route} is a governed noindex redirect stub, not a content page`);
    await page.goto(route);
    const expected = await page.locator('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').count();
    const visited = new Set<string>();
    for (let index = 0; index < expected; index += 1) {
      await page.keyboard.press("Tab");
      const marker = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || active === document.body) return "";
        const elements = Array.from(document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        return String(elements.indexOf(active));
      });
      expect(marker, `focus disappeared at tab ${index + 1}`).not.toBe("");
      expect(marker, "Tab must follow distinct elements in DOM order").toBe(String(index));
      visited.add(marker);
    }
    expect(visited.size).toBe(expected);
  });
}
