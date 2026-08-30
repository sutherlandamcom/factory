import { defineConfig, devices } from "@playwright/test";

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
const baseUrl = `http://localhost:${port}`;
const testOrigin = process.env.PUBLIC_SITE_URL || "https://test.example.com";

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
  webServer: {
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
