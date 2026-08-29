/**
 * Environment allowlist for every child process the executor spawns
 * (dependency prep, Codex, QA). Only these variables are forwarded from the
 * parent environment — secrets such as CLOUDFLARE_*, GITHUB_*,
 * DATABASE_URL, DATAFORSEO_*, FIRECRAWL_*, SMTP_* and unrelated API keys are
 * excluded by construction.
 *
 * Codex reads its auth/config from $CODEX_HOME (default ~/.codex via HOME),
 * so HOME and CODEX_HOME are the only auth-relevant entries.
 */
const ALLOWED_ENV_VARS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "CODEX_HOME",
] as const;

export function buildChildEnv(
  parent: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_VARS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}
