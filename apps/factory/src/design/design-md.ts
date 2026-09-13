import { lint } from "@google/design.md/linter";

/** Pinned portable validator plus Factory's stricter accepted-artifact requirements. */
export const DESIGN_MD_TOOL_VERSION = "@google/design.md@0.4.0+factory-design-requirements-v1";

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
  tokenNames: string[];
}

/**
 * Official tooling owns YAML/markdown parsing, token resolution, portable
 * lint and contrast checks. Factory additionally requires front matter,
 * a named identity and a resolved primary color: upstream intentionally
 * permits omissions with warnings, which is insufficient for our artifact.
 * No provider call or subprocess occurs here; raw bytes remain unchanged.
 */
export function lintDesignMd(markdown: string): DesignMdLintReport {
  const findings: DesignMdLintFinding[] = [];
  let tokenNames: string[] = [];
  try {
    const report = lint(markdown);
    findings.push(...report.findings.map((finding) => ({
      severity: finding.severity, rule: finding.rule ?? "official-parse", message: finding.message,
    })));
    if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(markdown)) {
      findings.push({ severity: "error", rule: "front-matter", message: "Factory requires DESIGN.md front matter." });
    }
    if (!report.designSystem?.name?.trim()) {
      findings.push({ severity: "error", rule: "missing-name", message: "Factory requires a named design identity." });
    }
    if (!report.designSystem?.colors?.has("primary")) {
      findings.push({ severity: "error", rule: "missing-colors", message: "Factory requires a resolved primary color." });
    }
    tokenNames = [...(report.designSystem?.symbolTable?.keys() ?? [])];
    if (report.designSystem?.name) tokenNames.push("name");
    tokenNames.sort();
  } catch {
    findings.push({ severity: "error", rule: "official-parse", message: "Official DESIGN.md parsing or model resolution failed." });
  }
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
