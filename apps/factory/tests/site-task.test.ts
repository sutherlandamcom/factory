import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  exampleSiteTask,
  parseSiteTask,
  siteTaskSchema,
  MAX_TASK_PAYLOAD_BYTES,
} from "@factory/contracts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("valid SiteTask passes validation", () => {
  const parsed = parseSiteTask(exampleSiteTask);
  assert.equal(parsed.type, "create_page");
  assert.equal(parsed.page.slug, "/services/roof-repair");
  assert.equal(parsed.siteId, "demo");
});

test("canonical JSON fixture passes validation", async () => {
  const raw = await readFile(
    path.join(repoRoot, "packages", "contracts", "fixtures", "create-roof-repair.json"),
    "utf8",
  );
  const parsed = siteTaskSchema.parse(JSON.parse(raw));
  assert.equal(parsed.siteId, "demo");
  assert.equal(parsed.page.slug, "/services/roof-repair");
  assert.equal(parsed.page.title, "Roof Repair");
});

test("structurally invalid SiteTask is rejected", () => {
  assert.throws(() => parseSiteTask(null));
  assert.throws(() => parseSiteTask(undefined));
  assert.throws(() => parseSiteTask({}));
  assert.throws(() => parseSiteTask({ type: "create_page", siteId: "demo" }));
  assert.throws(() => parseSiteTask({ type: "delete_page", siteId: "demo", page: {} }));
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "service", slug: "/services/x", title: "", description: "d", sections: ["hero"] },
    }),
  );
});

test("unexpected keys are rejected (.strict)", () => {
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "Roof Repair",
        description: "Services",
        sections: ["hero"],
        extraKey: "forbidden",
      },
    }),
  );
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "Roof Repair",
        description: "Services",
        sections: ["hero"],
      },
      topLevelExtra: true,
    }),
  );
});

test("invalid siteId formats are rejected", () => {
  const invalidSiteIds = [
    "",
    "../demo",
    "/demo",
    "demo/site",
    "demo\\site",
    "demo.site",
    "Demo",
    "DEMO",
    "demo_site",
    "demo site",
    "-demo",
    "demo-",
    "demo--site",
    "a".repeat(65),
  ];
  for (const siteId of invalidSiteIds) {
    assert.throws(
      () =>
        parseSiteTask({
          type: "create_page",
          siteId,
          page: {
            type: "service",
            slug: "/services/roof-repair",
            title: "Roof Repair",
            description: "Services",
            sections: ["hero"],
          },
        }),
      `siteId should be rejected: ${JSON.stringify(siteId)}`,
    );
  }
});

test("valid siteId formats are accepted", () => {
  for (const siteId of ["demo", "summit-roofing", "site-123", "a"]) {
    const task = parseSiteTask({
      type: "create_page",
      siteId,
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "Roof Repair",
        description: "Services",
        sections: ["hero"],
      },
    });
    assert.equal(task.siteId, siteId);
  }
});

test("unsafe slugs are rejected", () => {
  const unsafe = [
    "/../etc/passwd",
    "/services/../../secret",
    "/services/./roof",
    "/services\\roof",
    "C:\\windows",
    "https://example.com/services/roof",
    "//example.com/services/roof",
    "/services/roof repair?q=1",
    "/services/roof#frag",
    "/services//roof",
    "/Services/Roof",
    "/services/roof_repair",
    "/services/roof.repair",
    "services/roof",
    "",
    "/services/",
    "/services/roof/",
  ];
  for (const slug of unsafe) {
    assert.throws(
      () =>
        parseSiteTask({
          type: "create_page",
          siteId: "demo",
          page: { type: "service", slug, title: "T", description: "d", sections: ["hero"] },
        }),
      `slug should be rejected: ${JSON.stringify(slug)}`,
    );
  }
});

test("coherent page-type and slug relationships are enforced", () => {
  // Homepage must have slug "/"
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "homepage", slug: "/services/roof-repair", title: "T", description: "D", sections: ["hero"] },
    }),
  );
  const home = parseSiteTask({
    type: "create_page",
    siteId: "demo",
    page: { type: "homepage", slug: "/", title: "T", description: "D", sections: ["hero"] },
  });
  assert.equal(home.page.slug, "/");

  // Service must start with "/services/"
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "service", slug: "/blog/roof-repair", title: "T", description: "D", sections: ["hero"] },
    }),
  );
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "service", slug: "/", title: "T", description: "D", sections: ["hero"] },
    }),
  );

  // Article must start with "/blog/"
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "article", slug: "/services/roof-repair", title: "T", description: "D", sections: ["hero"] },
    }),
  );
  const article = parseSiteTask({
    type: "create_page",
    siteId: "demo",
    page: { type: "article", slug: "/blog/roof-repair", title: "T", description: "D", sections: ["hero"] },
  });
  assert.equal(article.page.slug, "/blog/roof-repair");
});

test("sections vocabulary and uniqueness are enforced", () => {
  // Unknown section rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "T",
        description: "D",
        sections: ["hero", "unknown_section" as any],
      },
    }),
  );

  // Duplicate sections rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "T",
        description: "D",
        sections: ["hero", "benefits", "hero"],
      },
    }),
  );

  // Empty sections rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "T",
        description: "D",
        sections: [],
      },
    }),
  );
});

test("empty or excessive text limits are enforced", () => {
  // Whitespace-only title rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "service", slug: "/services/roof-repair", title: "   ", description: "D", sections: ["hero"] },
    }),
  );

  // Title > 200 chars rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "a".repeat(201),
        description: "D",
        sections: ["hero"],
      },
    }),
  );

  // Description > 500 chars rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "T",
        description: "a".repeat(501),
        sections: ["hero"],
      },
    }),
  );
});

test("payload size bound is enforced", () => {
  const hugeString = "a".repeat(MAX_TASK_PAYLOAD_BYTES + 10);
  assert.throws(() => parseSiteTask(hugeString));

  const hugeObj = {
    type: "create_page",
    siteId: "demo",
    page: {
      type: "service",
      slug: "/services/roof-repair",
      title: "T",
      description: "D",
      sections: ["hero"],
      overflow: "x".repeat(MAX_TASK_PAYLOAD_BYTES),
    },
  };
  assert.throws(() => parseSiteTask(hugeObj));
});
