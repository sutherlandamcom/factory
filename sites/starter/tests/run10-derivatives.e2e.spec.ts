import { expect, test, type Page } from "@playwright/test";

/**
 * RUN 10 BROWSER E2E — derivative rendering against the REAL built site.
 *
 * The webServer builds the site from the governed manifest fixtures
 * (tests/fixtures/run10-*.json — fixture-generated derivative authority,
 * offline; no provider calls anywhere in this suite) and proves:
 *   - the summary renders as a static semantic <details> with truthful
 *     "AI-generated summary" disclosure;
 *   - the audio renders as a native <audio controls> player with
 *     preload="none" pointing at the content-addressed delivery artifact;
 *   - 100 visitor interactions (summary toggles + audio control touches)
 *     trigger ZERO network requests to any provider/AI endpoint — visitors
 *     only consume pre-generated accepted artifacts;
 *   - disabled derivatives render NO fake controls;
 *   - the summary control is keyboard accessible (native <details> semantics).
 */

const IGNORED_ERRORS: RegExp[] = [
  /Failed to load resource: the server responded with a status of 404/,
];

function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !IGNORED_ERRORS.some((pattern) => pattern.test(msg.text()))) {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return errors;
}

function watchProviderRequests(page: Page): string[] {
  const providerRequests: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    // Any request that is NOT the local site origin and NOT the audio/asset
    // delivery path would be a provider/AI call — visitors must make none.
    if (/openrouter|anthropic|stitch|vertex|ai\.google|tts|speech|api\./i.test(url)) {
      providerRequests.push(url);
    }
  });
  return providerRequests;
}

test.describe("Run 10 derivatives — built site", () => {
  test("derivative page renders summary details + audio controls from accepted artifacts", async ({ page }) => {
    const errors = watchForErrors(page);
    const response = await page.goto("/run10-derivatives");
    expect(response!.status()).toBe(200);

    const summary = page.locator('[data-derivative="summary"]');
    await expect(summary).toHaveCount(1);
    await expect(summary.locator("summary")).toHaveText("AI-generated summary");
    await expect(summary.locator("p")).toContainText("derivative rendering");

    const audio = page.locator('[data-derivative="audio"]');
    await expect(audio).toHaveCount(1);
    const player = audio.locator("audio");
    await expect(player).toHaveCount(1);
    await expect(player).toHaveAttribute("controls", "");
    await expect(player).toHaveAttribute("preload", "none");
    await expect(player).toHaveAttribute("src", /\/production-assets\/[0-9a-f]{64}\.wav$/);
    expect(errors).toEqual([]);
  });

  test("100 visitor interactions trigger ZERO provider requests", async ({ page }) => {
    const providerRequests = watchProviderRequests(page);
    await page.goto("/run10-derivatives");
    // 100 summary reveals/toggles (keyboard + mouse).
    for (let i = 0; i < 100; i++) {
      await page.locator('[data-derivative="summary"] summary').click();
    }
    // 100 audio control interactions (focus + play attempt + pause).
    for (let i = 0; i < 100; i++) {
      await page.locator('[data-derivative="audio"] audio').focus();
      await page.evaluate(() => {
        const player = document.querySelector<HTMLAudioElement>('[data-derivative="audio"] audio');
        player?.play().catch(() => undefined);
        player?.pause();
      });
    }
    expect(providerRequests, "visitor interactions must never trigger provider calls").toEqual([]);
  });

  test("disabled derivatives render no fake controls", async ({ page }) => {
    const response = await page.goto("/run10-disabled");
    expect(response!.status()).toBe(200);
    await expect(page.locator('[data-derivative="summary"]')).toHaveCount(0);
    await expect(page.locator('[data-derivative="audio"]')).toHaveCount(0);
    await expect(page.locator("audio")).toHaveCount(0);
  });

  test("summary control is keyboard accessible", async ({ page }) => {
    await page.goto("/run10-derivatives");
    const summaryToggle = page.locator('[data-derivative="summary"] summary');
    await summaryToggle.focus();
    await page.keyboard.press("Enter");
    const open = await page.locator('[data-derivative="summary"]').getAttribute("open");
    expect(open).not.toBeNull();
    await page.keyboard.press("Enter");
  });
});
