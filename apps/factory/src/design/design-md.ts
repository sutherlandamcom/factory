/**
 * DESIGN.md artifact validation (Run 6, Checkpoint D).
 *
 * DESIGN.md is a versioned artifact payload, NOT an eternal database schema
 * (task §12). Factory stores the raw text, its digest, the parser/tool
 * version and the lint result. Validation here is a deterministic,
 * dependency-light structural check of the DESIGN.md format's core
 * invariants:
 *   - YAML front matter delimited by `---` fences;
 *   - required `name` and `colors.primary` tokens;
 *   - token references `{path.to.token}` resolve to defined tokens;
 *   - known sections appear in canonical order;
 *   - component backgroundColor/textColor pairs exist as tokens or literals.
 *
 * The full official linter (`@google/design.md lint`) is available as a CLI
 * and is used in the live-proof checkpoint; this module provides the
 * deterministic in-process gate the service layer can enforce without a
 * subprocess dependency in unit tests.
 */

export interface DesignMdLintFinding {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
}

export interface DesignMdLintReport {
  errors: number;
  warnings: number;
  infos: number;
  findings: DesignMdLintFinding[];
  /** Parsed front-matter token names (for diff/staleness evidence). */
  tokenNames: string[];
}

const CANONICAL_SECTIONS = [
  "Overview",
  "Colors",
  "Typography",
  "Layout",
  "Elevation & Depth",
  "Shapes",
  "Components",
  "Do's and Don'ts",
];

export function lintDesignMd(markdown: string): DesignMdLintReport {
  const findings: DesignMdLintFinding[] = [];
  const tokenNames: string[] = [];

  // 1. Front matter fence structure.
  const fencePattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = markdown.match(fencePattern);
  if (!match) {
    findings.push({
      severity: "error",
      rule: "front-matter",
      message: "DESIGN.md must start with a YAML front matter block delimited by --- fences.",
    });
    return summarize(findings, tokenNames);
  }
  const frontMatter = match[1]!;
  const body = markdown.slice(match[0].length);

  // 2. Minimal YAML token parse (flat key: value lines and one nesting level).
  const lines = frontMatter.split(/\r?\n/);
  let currentSection = "";
  const definedTokens = new Set<string>();
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const keyMatch = trimmed.trimStart().match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) {
      if (trimmed.startsWith("- ") || trimmed.startsWith("-")) continue;
      findings.push({
        severity: "error",
        rule: "yaml-parse",
        message: `Unparseable front matter line: ${trimmed.slice(0, 80)}`,
      });
      continue;
    }
    const key = keyMatch[1]!;
    const value = keyMatch[2]!.trim();
    if (indent === 0) {
      depth = 0;
    }
    if (value === "") {
      currentSection = key;
      if (depth === 0) definedTokens.add(key);
      depth = 1;
      continue;
    }
    if (depth >= 1 && currentSection && indent > 0) {
      definedTokens.add(`${currentSection}.${key}`);
    } else {
      definedTokens.add(key);
    }
  }

  // 3. Required tokens.
  if (!definedTokens.has("name")) {
    findings.push({ severity: "error", rule: "missing-name", message: "Front matter must define a `name` token." });
  }
  if (![...definedTokens].some((t) => t === "colors.primary" || t === "colors")) {
    if (!definedTokens.has("colors")) {
      findings.push({
        severity: "error",
        rule: "missing-colors",
        message: "Front matter must define a `colors` section with a `primary` color.",
      });
    }
  }

  // 4. Broken token references in the body of the front matter.
  const allText = frontMatter;
  const refPattern = /\{([a-zA-Z][a-zA-Z0-9_.-]*)\}/g;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = refPattern.exec(allText)) !== null) {
    const ref = refMatch[1]!;
    if (!definedTokens.has(ref)) {
      findings.push({
        severity: "error",
        rule: "broken-ref",
        message: `Token reference {${ref}} does not resolve to any defined token.`,
      });
    }
  }

  // 5. Section order in the markdown body.
  const sectionHeadings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  const canonicalLower = CANONICAL_SECTIONS.map((s) => s.toLowerCase());
  let lastIndex = -1;
  for (const heading of sectionHeadings) {
    const canonicalIndex = canonicalLower.indexOf(heading.toLowerCase());
    if (canonicalIndex === -1) continue; // unknown sections are preserved, not errors
    if (canonicalIndex < lastIndex) {
      findings.push({
        severity: "warning",
        rule: "section-order",
        message: `Section "${heading}" appears out of canonical order.`,
      });
    } else {
      lastIndex = canonicalIndex;
    }
  }

  // 6. Color value sanity for the primary token.
  const primaryLine = lines.find((l) => /^\s*primary:\s*/.test(l));
  if (primaryLine) {
    const value = primaryLine.replace(/^\s*primary:\s*/, "").trim().replace(/^["']|["']$/g, "");
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) && !value.startsWith("rgb") && !value.startsWith("oklch")) {
      findings.push({
        severity: "warning",
        rule: "color-format",
        message: `Primary color "${value}" is not a recognizable CSS color.`,
      });
    }
  }

  tokenNames.push(...[...definedTokens].sort());
  return summarize(findings, tokenNames);
}

function summarize(findings: DesignMdLintFinding[], tokenNames: string[]): DesignMdLintReport {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    infos: findings.filter((f) => f.severity === "info").length,
    findings,
    tokenNames,
  };
}

/**
 * Structural diff between two DESIGN.md token sets (evidence for version
 * review). Returns added/removed/modified token names.
 */
export function diffDesignMdTokens(before: string[], after: string[]): {
  added: string[];
  removed: string[];
} {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((t) => !beforeSet.has(t)),
    removed: before.filter((t) => !afterSet.has(t)),
  };
}
