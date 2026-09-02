import { defineConfig, devices } from "@playwright/test";
import { resolveCanonicalOrigin } from "@factory/contracts";
import { siteProfile } from "./src/lib/site-profile.js";

function resolvePort(): number {
  const raw = process.env.FACTORY_QA_PORT;
  if (!raw) {
    return 4321;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `FACTORY_QA_PORT must be an integer between 1 and 65535, received: ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

const port = resolvePort();
const remoteBaseUrl = process.env.FACTORY_QA_BASE_URL;
function resolveBaseUrl(): string {
  if (!remoteBaseUrl) return `http://localhost:${port}`;
  const url = new URL(remoteBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("FACTORY_QA_BASE_URL must be a credential-free HTTPS origin.");
  }
  return url.origin;
}
const baseUrl = resolveBaseUrl();
// Canonical-origin expectation precedence mirrors astro.config.ts exactly:
// an explicitly configured PUBLIC_SITE_URL wins; otherwise the validated
// SiteProfile canonicalOrigin is the expectation — the same value the site
// build will use.
const testOrigin = resolveCanonicalOrigin({
  override: process.env.PUBLIC_SITE_URL,
  profile: siteProfile,
});

/**
 * QA for the built static site. The webServer builds and serves the site via
 * `astro preview` so tests run against production output, not the dev server.
 */
export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: baseUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      // iPhone-sized mobile viewport. browserName is forced to chromium because
      // the iPhone device descriptor defaults to WebKit, which we don't install.
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: remoteBaseUrl
    ? undefined
    : {
        command: `pnpm run build && pnpm run preview --port ${port}`,
        url: baseUrl,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          ...process.env,
          ASTRO_PREVIEW_BACKGROUND: "0",
          PUBLIC_SITE_URL: testOrigin,
        },
      },
});
