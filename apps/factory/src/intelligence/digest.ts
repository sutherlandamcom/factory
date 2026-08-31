import { createHash } from "node:crypto";

/**
 * Deterministic digest helpers for the Intelligence pipeline.
 *
 * Canonical JSON serialization: object keys are recursively sorted, array
 * order is preserved (meaningful), insignificant whitespace is removed.
 * Digests therefore depend only on content — never on key insertion order,
 * run ids, timestamps, paths, or process details.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entryValue)}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonicalJsonStringify cannot serialize value of type ${typeof value}`);
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** SHA-256 over the canonical JSON form of a validated value. */
export function deterministicDigest(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value));
}
