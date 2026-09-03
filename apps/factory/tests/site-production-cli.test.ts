import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  makeGenericBlueprint,
  makeGenericProductionSpec,
  makeGenericSiteProfile,
} from "./fixtures/site-production-fixtures.js";

const execFileAsync = promisify(execFile);

async function createCliTestFixture(): Promise<{
  tempDir: string;
  specPath: string;
  bpPath: string;
  profPath: string;
  inputRoot: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "site-production-cli-"));
  const inputRoot = path.join(tempDir, "production-input");
  await mkdir(path.join(inputRoot, "references"), { recursive: true });
  await mkdir(path.join(inputRoot, "assets"), { recursive: true });

  await writeFile(
    path.join(inputRoot, "references", "swiss-banking-annual-report.png"),
    "mock-png-cli-bytes",
  );
  await writeFile(
    path.join(inputRoot, "assets", "meridian-headquarters-exterior.jpg"),
    "mock-jpg-cli-bytes",
  );
  await writeFile(
    path.join(inputRoot, "assets", "meridian-mark.svg"),
    "<svg>cli</svg>",
  );

  const blueprint = makeGenericBlueprint();
  const profile = makeGenericSiteProfile();
  const spec = makeGenericProductionSpec(blueprint);

  const specPath = path.join(tempDir, "site-production-spec.json");
  const bpPath = path.join(tempDir, "site-blueprint.json");
  const profPath = path.join(tempDir, "site-profile.json");

  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");
  await writeFile(bpPath, JSON.stringify(blueprint, null, 2), "utf8");
  await writeFile(profPath, JSON.stringify(profile, null, 2), "utf8");

  return {
    tempDir,
    specPath,
    bpPath,
    profPath,
    inputRoot,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test("CLI: site-production validate prints valid JSON result", async () => {
  const fixture = await createCliTestFixture();
  try {
    const tsxPath = path.resolve("node_modules/.bin/tsx");
    const { stdout } = await execFileAsync(
      tsxPath,
      [
        "src/index.ts",
        "site-production",
        "validate",
        fixture.specPath,
        "--blueprint",
        fixture.bpPath,
        "--profile",
        fixture.profPath,
      ],
      { cwd: path.resolve(".") },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI: site-production readiness prints valid JSON status READY", async () => {
  const fixture = await createCliTestFixture();
  try {
    const tsxPath = path.resolve("node_modules/.bin/tsx");
    const { stdout } = await execFileAsync(
      tsxPath,
      [
        "src/index.ts",
        "site-production",
        "readiness",
        fixture.specPath,
        "--input-root",
        fixture.inputRoot,
        "--blueprint",
        fixture.bpPath,
        "--profile",
        fixture.profPath,
      ],
      { cwd: path.resolve(".") },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.status, "READY");
    assert.equal(result.readyPageCount, 1);
    assert.equal(result.blockedPageCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("CLI: site-production page-packet outputs bounded PageProductionPacket", async () => {
  const fixture = await createCliTestFixture();
  try {
    const tsxPath = path.resolve("node_modules/.bin/tsx");
    const { stdout } = await execFileAsync(
      tsxPath,
      [
        "src/index.ts",
        "site-production",
        "page-packet",
        fixture.specPath,
        "/",
        "--blueprint",
        fixture.bpPath,
        "--profile",
        fixture.profPath,
        "--input-root",
        fixture.inputRoot,
      ],
      { cwd: path.resolve(".") },
    );

    const packet = JSON.parse(stdout);
    assert.equal(packet.blueprintPage.slug, "/");
    assert.equal(packet.site.siteId, "meridian-advisory");
    assert.ok(packet.references.length > 0);
    assert.ok(packet.assets.length > 0);
  } finally {
    await fixture.cleanup();
  }
});
