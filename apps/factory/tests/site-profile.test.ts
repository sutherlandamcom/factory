import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  MAX_SITE_PROFILE_NAVIGATION_ENTRIES,
  parseSiteProfile,
  resolveCanonicalOrigin,
  siteProfileSchema,
} from "@factory/contracts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const validProfile = {
  version: "v0",
  siteId: "starter",
  siteName: "Summit Roofing Co.",
  canonicalOrigin: "http://localhost:4321",
  language: "en",
  navigation: [
    { label: "Home", targetSlug: "/" },
    { label: "Services", targetSlug: "/services/example" },
    { label: "Blog", targetSlug: "/blog/example" },
  ],
  addressLines: ["432 Demo Peak Road, Boulder, CO 80302"],
};

test("valid SiteProfile passes validation", () => {
  const parsed = parseSiteProfile(validProfile);
  assert.equal(parsed.version, "v0");
  assert.equal(parsed.siteId, "starter");
  assert.equal(parsed.siteName, "Summit Roofing Co.");
  assert.equal(parsed.canonicalOrigin, "http://localhost:4321");
  assert.equal(parsed.language, "en");
  assert.equal(parsed.navigation.length, 3);
  assert.deepEqual(parsed.addressLines, ["432 Demo Peak Road, Boulder, CO 80302"]);
});

test("the repository-owned starter profile JSON parses with the shared contract", async () => {
  const raw = await readFile(path.join(repoRoot, "sites", "starter", "site-profile.json"), "utf8");
  const parsed = siteProfileSchema.parse(JSON.parse(raw));
  // Single source of truth: site identity lives ONLY in the data file.
  // These assertions mirror the current real profile (Sutherland Private
  // Office) and keep the contract check intact.
  assert.equal(parsed.siteId, "sutherland-private-office");
  assert.equal(parsed.siteName, "Sutherland Private Office");
  assert.equal(parsed.canonicalOrigin, "https://sutherlandam.com");
  assert.equal(parsed.addressLines, undefined);
  assert.deepEqual(
    parsed.navigation.map((entry) => entry.targetSlug),
    ["/", "/chamonix-market-intelligence", "/megeve-market-intelligence"],
  );
});

test("canonicalOrigin is normalized to the bare origin", () => {
  assert.equal(parseSiteProfile({ ...validProfile, canonicalOrigin: "https://example.com" }).canonicalOrigin, "https://example.com");
  assert.equal(parseSiteProfile({ ...validProfile, canonicalOrigin: "https://example.com/" }).canonicalOrigin, "https://example.com");
});

test("unknown top-level field is rejected (.strict)", () => {
  assert.throws(() => parseSiteProfile({ ...validProfile, titleSuffix: " | Example" }));
  assert.throws(() => parseSiteProfile({ ...validProfile, theme: "dark" }));
});

test("unknown field inside a navigation entry is rejected", () => {
  assert.throws(() =>
    parseSiteProfile({
      ...validProfile,
      navigation: [{ label: "Home", targetSlug: "/", href: "/" }],
    }),
  );
});

test("empty or whitespace-only siteName is rejected", () => {
  assert.throws(() => parseSiteProfile({ ...validProfile, siteName: "" }), /siteName/);
  assert.throws(() => parseSiteProfile({ ...validProfile, siteName: "   " }), /siteName/);
});

test("oversized siteName is rejected", () => {
  assert.throws(() => parseSiteProfile({ ...validProfile, siteName: "A".repeat(101) }), /siteName/);
});

for (const [name, canonical] of [
  ["ftp scheme", "ftp://example.com"],
  ["credentials", "https://user:pass@example.com"],
  ["query", "https://example.com/?tracking=1"],
  ["fragment", "https://example.com/#section"],
  ["non-root pathname", "https://example.com/site"],
  ["not a URL", "example.com"],
  ["empty string", ""],
] as const) {
  test(`invalid canonicalOrigin (${name}) is rejected`, () => {
    assert.throws(() => parseSiteProfile({ ...validProfile, canonicalOrigin: canonical }), /canonicalOrigin/);
  });
}

for (const [name, target] of [
  ["unrooted slug", "services/example"],
  ["trailing slash", "/services/example/"],
  ["traversal", "/../escape"],
  ["uppercase", "/Services/Example"],
  ["query", "/services/example?q=1"],
  ["empty", ""],
] as const) {
  test(`invalid navigation targetSlug (${name}) is rejected`, () => {
    assert.throws(
      () => parseSiteProfile({ ...validProfile, navigation: [{ label: "Bad", targetSlug: target }] }),
      /targetSlug/,
    );
  });
}

test("empty navigation is rejected", () => {
  assert.throws(() => parseSiteProfile({ ...validProfile, navigation: [] }), /navigation/);
});

test("navigation beyond the MVP bound is rejected", () => {
  const entries = Array.from({ length: MAX_SITE_PROFILE_NAVIGATION_ENTRIES + 1 }, (_, index) => ({
    label: `Item ${index + 1}`,
    targetSlug: `/page-${index + 1}`,
  }));
  assert.throws(() => parseSiteProfile({ ...validProfile, navigation: entries }), /navigation/);
});

test("navigation entries containing HTML are rejected", () => {
  assert.throws(
    () => parseSiteProfile({ ...validProfile, navigation: [{ label: "<script>", targetSlug: "/" }] }),
    /HTML/,
  );
});

test("address lines are bounded and reject HTML", () => {
  assert.throws(() => parseSiteProfile({ ...validProfile, addressLines: ["<b>evil</b>"] }), /HTML/);
  assert.throws(
    () => parseSiteProfile({ ...validProfile, addressLines: Array.from({ length: 11 }, () => "line") }),
    /addressLines/,
  );
  assert.throws(() => parseSiteProfile({ ...validProfile, addressLines: [""] }), /address line/);
});

for (const [name, language] of [
  ["single character", "e"],
  ["underscore separator", "en_GB"],
  ["unbounded length", "en-gb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["empty", ""],
  ["numeric only", "123"],
] as const) {
  test(`invalid language (${name}) is rejected`, () => {
    assert.throws(() => parseSiteProfile({ ...validProfile, language }), /language/);
  });
}

test("BCP47-compatible language variants pass", () => {
  assert.equal(parseSiteProfile({ ...validProfile, language: "en-GB" }).language, "en-GB");
});

test("malformed JSON string input is rejected", () => {
  assert.throws(() => parseSiteProfile("{not json"));
  assert.throws(() => parseSiteProfile(null));
  assert.throws(() => parseSiteProfile(undefined));
});

test("resolveCanonicalOrigin defaults to the profile origin", () => {
  assert.equal(
    resolveCanonicalOrigin({ profile: { canonicalOrigin: "http://localhost:4321" } }),
    "http://localhost:4321",
  );
  assert.equal(
    resolveCanonicalOrigin({ override: undefined, profile: { canonicalOrigin: "http://localhost:4321" } }),
    "http://localhost:4321",
  );
  assert.equal(
    resolveCanonicalOrigin({ override: "", profile: { canonicalOrigin: "http://localhost:4321" } }),
    "http://localhost:4321",
  );
});

test("resolveCanonicalOrigin defaults to non-local profile canonical when override is absent (not localhost)", () => {
  const nonLocalProfile = { canonicalOrigin: "https://example-real-site.test" };
  assert.equal(
    resolveCanonicalOrigin({ profile: nonLocalProfile }),
    "https://example-real-site.test",
  );
  assert.equal(
    resolveCanonicalOrigin({ override: undefined, profile: nonLocalProfile }),
    "https://example-real-site.test",
  );
  assert.equal(
    resolveCanonicalOrigin({ override: "", profile: nonLocalProfile }),
    "https://example-real-site.test",
  );
  assert.notEqual(
    resolveCanonicalOrigin({ profile: nonLocalProfile }),
    "http://localhost:4321",
  );
});

test("resolveCanonicalOrigin prefers a valid explicit override", () => {
  assert.equal(
    resolveCanonicalOrigin({ override: "https://test.example.com", profile: { canonicalOrigin: "http://localhost:4321" } }),
    "https://test.example.com",
  );
  assert.equal(
    resolveCanonicalOrigin({ override: "https://test.example.com/", profile: { canonicalOrigin: "http://localhost:4321" } }),
    "https://test.example.com",
  );
  assert.equal(
    resolveCanonicalOrigin({
      override: "https://test.example.com",
      profile: { canonicalOrigin: "https://example-real-site.test" },
    }),
    "https://test.example.com",
  );
});

for (const override of ["https://user:pass@evil.invalid", "https://evil.invalid/path", "https://evil.invalid/?q=1", "not-a-url"]) {
  test(`resolveCanonicalOrigin throws on invalid override ${JSON.stringify(override)} (no silent fallback)`, () => {
    assert.throws(
      () => resolveCanonicalOrigin({ override, profile: { canonicalOrigin: "http://localhost:4321" } }),
      /canonicalOrigin/,
    );
  });
}
