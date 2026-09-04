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

test("general pages accept ordinary flat and hierarchical routes", () => {
  for (const slug of [
    "/about",
    "/private-office",
    "/market-intelligence",
    "/strategic-briefing",
    "/private-office/approach",
    "/research/methodology",
    "/index-methodology",
    "/private-office/index-strategy",
    "/index/approach",
  ]) {
    const task = parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "general", slug, title: "General Page", description: "General page description", sections: ["hero"] },
    });
    assert.equal(task.page.type, "general");
    assert.equal(task.page.slug, slug);
  }
});

test("general pages reject terminal-index routes to prevent Astro index route ambiguity", () => {
  for (const slug of [
    "/index",
    "/private-office/index",
    "/foo/bar/index",
  ]) {
    assert.throws(
      () => parseSiteTask({
        type: "create_page",
        siteId: "demo",
        page: { type: "general", slug, title: "General Page", description: "General page description", sections: ["hero"] },
      }),
      /reserved Astro directory segment/,
      `terminal index route should be rejected: ${slug}`,
    );
  }
});

test("general pages reject root, semantic namespaces, and the Foundation 404 route", () => {
  for (const slug of [
    "/",
    "/services",
    "/services/acquisition-advisory",
    "/services/foo/bar",
    "/blog",
    "/blog/chamonix-property-market",
    "/blog/foo/bar",
    "/404",
  ]) {
    assert.throws(
      () => parseSiteTask({
        type: "create_page",
        siteId: "demo",
        page: { type: "general", slug, title: "General Page", description: "General page description", sections: ["hero"] },
      }),
      `general route should be rejected: ${slug}`,
    );
  }
});

test("general pages preserve global slug syntax rejection", () => {
  for (const slug of [
    "/about?mode=full",
    "/about#team",
    "/research/../about",
    "/private-office\\approach",
    "/private-office//approach",
    "/About",
    "/about/",
    "/invalid_segment",
  ]) {
    assert.throws(() => parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: { type: "general", slug, title: "General Page", description: "General page description", sections: ["hero"] },
    }));
  }
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

  // Repeated section instances are allowed (variable rhythm) up to the bound
  const repeatedOk = parseSiteTask({
    type: "create_page",
    siteId: "demo",
    page: {
      type: "service",
      slug: "/services/roof-repair",
      title: "T",
      description: "D",
      sections: ["hero", "content_section", "content_section", "content_section", "content_section", "faq"],
    },
  });
  assert.equal(repeatedOk.page.sections.length, 6);

  // More than MAX_SECTION_TYPE_INSTANCES of one type rejected
  assert.throws(() =>
    parseSiteTask({
      type: "create_page",
      siteId: "demo",
      page: {
        type: "service",
        slug: "/services/roof-repair",
        title: "T",
        description: "D",
        sections: ["hero", "faq", "faq", "faq", "faq", "faq"],
      },
    }),
    /instance bound exceeded/,
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

// ---------------------------------------------------------------------------
// contentBrief (PROVEN_MVP_CAPABILITY_GAP C1)
// ---------------------------------------------------------------------------

function validBriefTask() {
  return {
    type: "create_page",
    siteId: "demo",
    page: {
      type: "general",
      slug: "/insights/overview",
      title: "Market overview and verified insights",
      description: "Evidence-led regional overview and operational analysis.",
      sections: ["hero", "content_section", "faq"],
      contentBrief: {
        purpose: "Provide dated, source-backed operational context.",
        audience: "Commercial decision makers evaluating local facilities.",
        sourceBlueprintRunId: "20260901T114820Z-8976f5e5",
        sections: [
          {
            sectionType: "hero",
            heading: "Executive intelligence overview",
            keyPoints: ["Primary sector activity remained stable year over year."],
            prohibitedClaims: ["Do not guarantee specific returns or timeline commitments."],
            blueprintSectionId: "sec-hero-overview",
          },
          {
            sectionType: "content_section",
            heading: "Empirical market indicators",
            keyPoints: ["Regulatory filings require independent validation prior to settlement."],
            leadProse: "Detailed operational review based on primary sources.",
            blueprintSectionId: "sec-indicators",
          },
          {
            sectionType: "faq",
            heading: "Verification guidelines",
            keyPoints: ["How are operational metrics validated across regional nodes?"],
            blueprintSectionId: "sec-faq",
          },
        ],
        internalLinks: [{ targetSlug: "/services/roof-repair", purpose: "Review maintenance capabilities." }],
      },
    },
  } as const;
}

test("valid contentBrief parses and is preserved", () => {
  const parsed = parseSiteTask(validBriefTask());
  assert.ok(parsed.page.contentBrief, "brief should be present");
  assert.equal(parsed.page.contentBrief.sections.length, 3);
  assert.equal(parsed.page.contentBrief.sourceBlueprintRunId, "20260901T114820Z-8976f5e5");
  assert.equal(parsed.page.contentBrief.internalLinks?.[0]?.targetSlug, "/services/roof-repair");
});

test("task without contentBrief still parses (backward compatible)", () => {
  const parsed = parseSiteTask({
    type: "create_page",
    siteId: "demo",
    page: {
      type: "service",
      slug: "/services/roof-repair",
      title: "T",
      description: "D",
      sections: ["hero"],
    },
  });
  assert.equal(parsed.page.contentBrief, undefined);
});

test("contentBrief sectionType mismatching page section order is rejected", () => {
  const task = JSON.parse(JSON.stringify(validBriefTask()));
  task.page.sections = ["hero", "content_section"];
  assert.throws(() => parseSiteTask(task), /does not match the page section at the same position/);
});

test("contentBrief missing entry for a page section is rejected", () => {
  const task = JSON.parse(JSON.stringify(validBriefTask()));
  task.page.contentBrief.sections = task.page.contentBrief.sections.slice(0, 2);
  assert.throws(() => parseSiteTask(task), /exactly one entry per page section/);
});

test("contentBrief duplicate sectionType is rejected (order mismatch)", () => {
  const task = JSON.parse(JSON.stringify(validBriefTask()));
  task.page.contentBrief.sections[1].sectionType = "hero";
  assert.throws(() => parseSiteTask(task), /does not match the page section at the same position/);
});

test("contentBrief supports repeated section instances with distinct briefs", () => {
  const task = JSON.parse(JSON.stringify(validBriefTask()));
  task.page.sections = ["hero", "content_section", "content_section", "faq"];
  task.page.contentBrief.sections = [
    task.page.contentBrief.sections[0],
    task.page.contentBrief.sections[1],
    {
      sectionType: "content_section",
      heading: "Second editorial band",
      keyPoints: ["Distinct key point for the repeated instance."],
      blueprintSectionId: "sec-indicators-2",
    },
    task.page.contentBrief.sections[2],
  ];
  const parsed = parseSiteTask(task);
  assert.equal(parsed.page.contentBrief!.sections.length, 4);
  assert.equal(parsed.page.contentBrief!.sections[2]!.heading, "Second editorial band");
});

test("contentBrief unknown fields fail closed", () => {
  const task = JSON.parse(JSON.stringify(validBriefTask()));
  task.page.contentBrief.injected = "payload";
  assert.throws(() => parseSiteTask(task));
  const sectionTask = JSON.parse(JSON.stringify(validBriefTask()));
  sectionTask.page.contentBrief.sections[0].visualRequirement = { required: true };
  assert.throws(() => parseSiteTask(sectionTask));
});

test("contentBrief bound enforcement", () => {
  // heading too long
  const longHeading = JSON.parse(JSON.stringify(validBriefTask()));
  longHeading.page.contentBrief.sections[0].heading = "h".repeat(121);
  assert.throws(() => parseSiteTask(longHeading));

  // > 8 key points
  const manyKeys = JSON.parse(JSON.stringify(validBriefTask()));
  manyKeys.page.contentBrief.sections[0].keyPoints = Array.from({ length: 9 }, (_, i) => `kp${i}`);
  assert.throws(() => parseSiteTask(manyKeys));

  // key point too long
  const longKey = JSON.parse(JSON.stringify(validBriefTask()));
  longKey.page.contentBrief.sections[0].keyPoints = ["k".repeat(281)];
  assert.throws(() => parseSiteTask(longKey));

  // > 6 prohibited claims
  const manyProhibited = JSON.parse(JSON.stringify(validBriefTask()));
  manyProhibited.page.contentBrief.sections[0].prohibitedClaims = Array.from(
    { length: 7 },
    (_, i) => `p${i}`,
  );
  assert.throws(() => parseSiteTask(manyProhibited));

  // > 8 internal links
  const manyLinks = JSON.parse(JSON.stringify(validBriefTask()));
  manyLinks.page.contentBrief.internalLinks = Array.from({ length: 9 }, (_, i) => ({
    targetSlug: `/route-${i}`,
    purpose: "link",
  }));
  assert.throws(() => parseSiteTask(manyLinks));

  // invalid targetSlug
  const badLink = JSON.parse(JSON.stringify(validBriefTask()));
  badLink.page.contentBrief.internalLinks = [{ targetSlug: "not-rooted", purpose: "link" }];
  assert.throws(() => parseSiteTask(badLink));

  // HTML in heading rejected
  const htmlHeading = JSON.parse(JSON.stringify(validBriefTask()));
  htmlHeading.page.contentBrief.sections[0].heading = "<script>alert(1)</script>";
  assert.throws(() => parseSiteTask(htmlHeading));

  // invalid blueprintSectionId format
  const badSectionId = JSON.parse(JSON.stringify(validBriefTask()));
  badSectionId.page.contentBrief.sections[0].blueprintSectionId = "Bad Id!";
  assert.throws(() => parseSiteTask(badSectionId));

  // invalid sourceBlueprintRunId
  const badRunId = JSON.parse(JSON.stringify(validBriefTask()));
  badRunId.page.contentBrief.sourceBlueprintRunId = "bad run id";
  assert.throws(() => parseSiteTask(badRunId));

  // empty keyPoints rejected
  const noKeys = JSON.parse(JSON.stringify(validBriefTask()));
  noKeys.page.contentBrief.sections[0].keyPoints = [];
  assert.throws(() => parseSiteTask(noKeys));
});

test("worker prompt incorporates contentBrief and business-truth instructions", async () => {
  const { buildWorkerPrompt, buildWorkerRepairPrompt } = await import("../src/executor/prompt.js");
  const { deriveTaskWritePolicy } = await import("../src/executor/module-policy.js");
  const task = parseSiteTask(validBriefTask());
  const policy = deriveTaskWritePolicy(task);

  const initialPrompt = buildWorkerPrompt(task, policy);
  assert.ok(
    initialPrompt.includes("page.contentBrief is present, it is accepted Factory business truth"),
    "initial prompt must explain contentBrief rules",
  );
  assert.ok(
    initialPrompt.includes("Executive intelligence overview"),
    "initial prompt must contain brief content in task JSON",
  );
  assert.ok(
    initialPrompt.includes("Do not guarantee specific returns"),
    "initial prompt must contain prohibited claims in task JSON",
  );

  const repairPrompt = buildWorkerRepairPrompt(
    task,
    {
      attemptNumber: 2,
      failingStage: "qa",
      failureCode: "qa_failed",
      summary: "heading mismatch",
      excerpt: "expected heading to match",
      targetSlug: task.page.slug,
      failingAssertions: ["expected heading to match"],
    },
    policy,
  );
  assert.ok(
    repairPrompt.includes("page.contentBrief is present, it is accepted Factory business truth"),
    "repair prompt must explain contentBrief rules",
  );
  assert.ok(
    repairPrompt.includes("Executive intelligence overview"),
    "repair prompt must contain brief content in task JSON",
  );
});
