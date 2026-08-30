import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    } else {
      throw new FactoryError(
        "artifact_invalid",
        `Static artifact contains unsupported filesystem entry '${path.relative(root, absolute)}'.`,
      );
    }
  }
  return files;
}

/** Stable SHA-256 over sorted relative paths and exact file contents. */
export async function digestArtifact(directory: string): Promise<string> {
  let files: string[];
  try {
    files = (await listFiles(directory)).sort((a, b) => a.localeCompare(b, "en"));
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    throw new FactoryError(
      "artifact_missing",
      `Unable to read built artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (files.length === 0) {
    throw new FactoryError("artifact_empty", "Built site artifact contains no files.");
  }
  const hash = createHash("sha256");
  for (const relative of files) {
    const content = await readFile(path.join(directory, ...relative.split("/")));
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}
