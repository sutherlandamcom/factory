import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

interface TaskQaSpec {
  route: string;
  title: string;
  documentTitle: string;
  description: string;
  pageType: "homepage" | "service" | "article";
  sections: string[];
  canonicalUrl: string;
}

const specPath = process.env.FACTORY_TASK_QA_SPEC;
const spec = specPath
  ? (JSON.parse(readFileSync(specPath, "utf8")) as TaskQaSpec)
  : undefined;

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

function normalize(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

test.describe("Factory task-aware generated page QA", () => {
  test("requested route satisfies the generated-page policy", async ({ page }, testInfo) => {
    test.skip(!spec, "Only enabled by Factory with a validated task QA specification");
    const task = spec!;
    const errors = watchForErrors(page);

    await test.step(`response ${task.route}`, async () => {
      console.log(`FACTORY_QA_GATE=response route=${task.route} project=${testInfo.project.name}`);
      const response = await page.goto(task.route);
      expect(response, `route=${task.route} requirement=response expected=response actual=null`).not.toBeNull();
      expect(response!.status(), `route=${task.route} requirement=response expected=200 actual=${response!.status()}`).toBe(200);
    });

    await test.step("title, H1, metadata, canonical, and Open Graph", async () => {
      console.log(`FACTORY_QA_GATE=title route=${task.route} project=${testInfo.project.name}`);
      await expect(page, `route=${task.route} requirement=title expected=${task.documentTitle}`).toHaveTitle(task.documentTitle);
      const h1 = page.locator("h1");
      console.log(`FACTORY_QA_GATE=h1-count route=${task.route} project=${testInfo.project.name}`);
      await expect(h1, `route=${task.route} requirement=h1-count expected=1`).toHaveCount(1);
      expect(normalize(await h1.textContent()), `route=${task.route} requirement=h1 expected=${task.title}`).toBe(task.title);

      const fields = [
        ['meta[name="description"]', "content", task.description, "description"],
        ['link[rel="canonical"]', "href", task.canonicalUrl, "canonical"],
        ['meta[property="og:title"]', "content", task.documentTitle, "og:title"],
        ['meta[property="og:description"]', "content", task.description, "og:description"],
        ['meta[property="og:url"]', "content", task.canonicalUrl, "og:url"],
      ] as const;
      for (const [selector, attribute, expected, requirement] of fields) {
        console.log(`FACTORY_QA_GATE=${requirement} route=${task.route} project=${testInfo.project.name}`);
        const locator = page.locator(selector);
        await expect(locator, `route=${task.route} requirement=${requirement}-count expected=1`).toHaveCount(1);
        await expect(locator, `route=${task.route} requirement=${requirement} expected=${expected}`).toHaveAttribute(attribute, expected);
      }
    });

    await test.step("JSON-LD identity", async () => {
      console.log(`FACTORY_QA_GATE=json-ld-parse route=${task.route} project=${testInfo.project.name}`);
      const scripts = page.locator('script[type="application/ld+json"]');
      await expect(scripts, `route=${task.route} requirement=json-ld-count expected=1`).toHaveCount(1);
      const raw = await scripts.textContent();
      let schema: Record<string, unknown>;
      try {
        schema = JSON.parse(raw ?? "") as Record<string, unknown>;
      } catch (error) {
        throw new Error(`route=${task.route} requirement=json-ld-parse actual=${error instanceof Error ? error.message : String(error)}`);
      }
      const expectedType = { homepage: "LocalBusiness", service: "Service", article: "Article" }[task.pageType];
      expect(schema["@context"], `route=${task.route} requirement=json-ld-context`).toBe("https://schema.org");
      expect(schema["@type"], `route=${task.route} requirement=json-ld-type expected=${expectedType}`).toBe(expectedType);
      if (task.pageType === "article") {
        expect(schema.headline, `route=${task.route} requirement=json-ld-headline`).toBe(task.title);
        expect((schema.mainEntityOfPage as Record<string, unknown> | undefined)?.["@id"], `route=${task.route} requirement=json-ld-url`).toBe(task.canonicalUrl);
      } else if (task.pageType === "service") {
        expect(schema.serviceType, `route=${task.route} requirement=json-ld-service-type`).toBe(task.title);
        expect(schema.url, `route=${task.route} requirement=json-ld-url`).toBe(task.canonicalUrl);
      } else {
        expect(normalize(String(schema.name ?? "")).length, `route=${task.route} requirement=json-ld-name`).toBeGreaterThan(0);
        expect(schema.url, `route=${task.route} requirement=json-ld-url`).toBe(task.canonicalUrl);
      }
    });

    await test.step("requested sections and meaningful body", async () => {
      if (task.sections.includes("cta")) {
        console.log(`FACTORY_QA_GATE=cta route=${task.route} project=${testInfo.project.name}`);
        const actions = page.locator("main a[href]:visible");
        expect(await actions.count(), `route=${task.route} requirement=cta expected=visible named action`).toBeGreaterThan(0);
        expect(normalize(await actions.first().textContent()).length, `route=${task.route} requirement=cta-name`).toBeGreaterThan(0);
      }
      if (task.sections.includes("faq")) {
        console.log(`FACTORY_QA_GATE=faq route=${task.route} project=${testInfo.project.name}`);
        const faqs = page.locator("main details");
        expect(await faqs.count(), `route=${task.route} requirement=faq expected=details`).toBeGreaterThan(0);
        expect(normalize(await faqs.first().textContent()).length, `route=${task.route} requirement=faq-content`).toBeGreaterThan(0);
      }
      const meaningfulText = await page.locator("main").evaluate((main) => {
        const clone = main.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("h1,h2,h3,h4,h5,h6,script,style").forEach((node) => node.remove());
        return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
      });
      console.log(`FACTORY_QA_GATE=meaningful-body route=${task.route} project=${testInfo.project.name}`);
      expect(meaningfulText.length, `route=${task.route} requirement=meaningful-body expected>=50 actual=${meaningfulText.length}`).toBeGreaterThanOrEqual(50);
    });

    await test.step("internal links resolve", async () => {
      const hrefs = await page.locator("a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
      const unique = [...new Set(hrefs.filter(Boolean))];
      expect(unique.length, `route=${task.route} requirement=bounded-links expected<=50 actual=${unique.length}`).toBeLessThanOrEqual(50);
      for (const href of unique) {
        if (/^(mailto:|tel:|javascript:)/i.test(href)) continue;
        const target = new URL(href, task.canonicalUrl);
        if (target.origin !== new URL(task.canonicalUrl).origin && target.origin !== new URL(page.url()).origin) continue;
        if (target.hash && target.pathname === new URL(task.canonicalUrl).pathname) {
          const found = await page.evaluate((id) => document.getElementById(id) !== null, decodeURIComponent(target.hash.slice(1)));
          expect(found, `route=${task.route} requirement=fragment-link actual=${href}`).toBe(true);
          continue;
        }
        const response = await page.request.get(`${target.pathname}${target.search}`);
        console.log(`FACTORY_QA_GATE=internal-link route=${task.route} project=${testInfo.project.name} href=${href}`);
        expect(response.status(), `route=${task.route} requirement=internal-link expected<400 actual=${response.status()} href=${href}`).toBeLessThan(400);
      }
    });

    await test.step("image semantics", async () => {
      const images = page.locator("img");
      for (let index = 0; index < await images.count(); index++) {
        const image = images.nth(index);
        const src = await image.getAttribute("src");
        console.log(`FACTORY_QA_GATE=image-src route=${task.route} project=${testInfo.project.name} index=${index}`);
        expect(src, `route=${task.route} requirement=image-src index=${index}`).toMatch(/^\/(?:_astro\/|[^/])/);
        const width = Number(await image.getAttribute("width"));
        const height = Number(await image.getAttribute("height"));
        console.log(`FACTORY_QA_GATE=image-width route=${task.route} project=${testInfo.project.name} index=${index}`);
        expect(width, `route=${task.route} requirement=image-width index=${index}`).toBeGreaterThan(0);
        expect(height, `route=${task.route} requirement=image-height index=${index}`).toBeGreaterThan(0);
        expect(await image.getAttribute("srcset"), `route=${task.route} requirement=image-srcset index=${index}`).toBeTruthy();
        expect(await image.getAttribute("sizes"), `route=${task.route} requirement=image-sizes index=${index}`).toBeTruthy();
        expect(await image.getAttribute("loading"), `route=${task.route} requirement=image-loading index=${index}`).toMatch(/^(eager|lazy)$/);
        const alt = normalize(await image.getAttribute("alt"));
        const decorative = (await image.getAttribute("role")) === "presentation" || (await image.getAttribute("aria-hidden")) === "true";
        if (!decorative) {
          console.log(`FACTORY_QA_GATE=image-alt route=${task.route} project=${testInfo.project.name} index=${index}`);
          expect(alt.length, `route=${task.route} requirement=image-alt index=${index}`).toBeGreaterThan(0);
        }
      }
    });

    await test.step("runtime errors and mobile overflow", async () => {
      console.log(`FACTORY_QA_GATE=page-errors route=${task.route} project=${testInfo.project.name}`);
      expect(errors, `route=${task.route} project=${testInfo.project.name} requirement=page-errors`).toEqual([]);
      if (testInfo.project.name === "mobile") {
        const dimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        console.log(`FACTORY_QA_GATE=horizontal-overflow route=${task.route} project=mobile`);
        expect(dimensions.scrollWidth, `route=${task.route} project=mobile requirement=horizontal-overflow client=${dimensions.clientWidth} scroll=${dimensions.scrollWidth}`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      }
    });

    await page.screenshot({
      path: `qa-artifacts/task-page-${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});
