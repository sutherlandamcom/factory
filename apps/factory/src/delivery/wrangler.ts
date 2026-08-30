import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FactoryError } from "../executor/errors.js";
import { runProcess, type ProcessResult } from "../executor/process.js";

const PROVIDER_TIMEOUT_MS = 300_000;
const LOG_LIMIT = 64 * 1024;

export interface UploadedVersion {
  versionId: string;
  previewUrl: string;
  workerName: string;
}

function requireCredentials(parent: NodeJS.ProcessEnv): { token: string; accountId: string } {
  const token = parent.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = parent.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) {
    throw new FactoryError(
      "cloudflare_credentials_unconfigured",
      "Trusted delivery requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  return { token, accountId };
}

/** Narrow environment used only for the trusted Wrangler subprocess. */
export function buildWranglerEnv(
  parent: NodeJS.ProcessEnv,
  outputFile?: string,
): NodeJS.ProcessEnv {
  const { token, accountId } = requireCredentials(parent);
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH,
    HOME: parent.HOME,
    TMPDIR: parent.TMPDIR,
    LANG: parent.LANG,
    LC_ALL: parent.LC_ALL,
    LC_CTYPE: parent.LC_CTYPE,
    TZ: parent.TZ,
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
  if (outputFile) env.WRANGLER_OUTPUT_FILE_PATH = outputFile;
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

function redact(value: string, env: NodeJS.ProcessEnv): string {
  let sanitized = value;
  for (const secret of [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID]) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
  return sanitized.slice(0, LOG_LIMIT);
}

function parseJson(value: string, errorCode: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new FactoryError(errorCode, "Cloudflare returned malformed structured JSON output.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNdjson(raw: string): Record<string, unknown>[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new FactoryError("provider_output_invalid", "Wrangler produced no structured output.");
  }
  return lines.map((line) => {
    const parsed = parseJson(line, "provider_output_invalid");
    if (!isObject(parsed)) {
      throw new FactoryError("provider_output_invalid", "Wrangler NDJSON record must be an object.");
    }
    return parsed;
  });
}

function singleRecord(records: Record<string, unknown>[], type: string): Record<string, unknown> {
  const failures = records.filter((record) => record.type === "command-failed");
  if (failures.length > 0) {
    throw new FactoryError("provider_command_failed", "Wrangler structured output reported command failure.");
  }
  const matches = records.filter((record) => record.type === type && record.version === 1);
  if (matches.length !== 1) {
    throw new FactoryError(
      "provider_output_invalid",
      `Expected exactly one Wrangler '${type}' success record, received ${matches.length}.`,
    );
  }
  return matches[0]!;
}

export function parseVersionUpload(raw: string, expectedWorker: string): UploadedVersion {
  const record = singleRecord(parseNdjson(raw), "version-upload");
  const versionId = record.version_id;
  const previewUrl = record.preview_url;
  const workerName = record.worker_name;
  if (typeof versionId !== "string" || versionId.length === 0) {
    throw new FactoryError("provider_output_invalid", "Wrangler upload omitted version_id.");
  }
  if (workerName !== expectedWorker) {
    throw new FactoryError("provider_identity_mismatch", "Wrangler upload returned an unexpected Worker identity.");
  }
  if (typeof previewUrl !== "string") {
    throw new FactoryError("provider_output_invalid", "Wrangler upload omitted preview_url.");
  }
  let url: URL;
  try {
    url = new URL(previewUrl);
  } catch {
    throw new FactoryError("provider_output_invalid", "Wrangler upload returned an invalid preview URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new FactoryError("provider_output_invalid", "Wrangler preview URL must be credential-free HTTPS.");
  }
  return { versionId, previewUrl: url.toString(), workerName };
}

export function parseCurrentVersion(raw: string): string | null {
  const parsed = parseJson(raw, "provider_status_invalid");
  if (!Array.isArray(parsed)) {
    throw new FactoryError("provider_status_invalid", "Wrangler deployments list output must be an array.");
  }
  if (parsed.length === 0) return null;
  // Wrangler 4.127.1 sorts `deployments list --json` oldest-to-newest.
  const latest = parsed.at(-1);
  if (!isObject(latest) || !Array.isArray(latest.versions)) {
    throw new FactoryError("provider_status_invalid", "Latest Cloudflare deployment omitted versions.");
  }
  if (latest.versions.length !== 1 || !isObject(latest.versions[0])) {
    throw new FactoryError("deployment_drift", "Production is not a single-version 100% deployment.");
  }
  const version = latest.versions[0];
  if (typeof version.version_id !== "string" || Number(version.percentage) !== 100) {
    throw new FactoryError("deployment_drift", "Production is not a single-version 100% deployment.");
  }
  return version.version_id;
}

export class WranglerClient {
  private readSequence = 0;

  constructor(
    private readonly siteDirectory: string,
    private readonly artifactDirectory: string,
    private readonly parentEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  private configPath(): string {
    return path.join(this.siteDirectory, "wrangler.jsonc");
  }

  private async run(args: string[], outputFile?: string): Promise<ProcessResult> {
    return await runProcess("pnpm", ["exec", "wrangler", ...args], {
      cwd: this.siteDirectory,
      env: buildWranglerEnv(this.parentEnv, outputFile),
      timeoutMs: PROVIDER_TIMEOUT_MS,
    });
  }

  private async persistLogs(operation: string, result: ProcessResult): Promise<void> {
    await writeFile(
      path.join(this.artifactDirectory, `wrangler-${operation}-stdout.txt`),
      redact(result.stdout, this.parentEnv),
      "utf8",
    );
    await writeFile(
      path.join(this.artifactDirectory, `wrangler-${operation}-stderr.txt`),
      redact(result.stderr, this.parentEnv),
      "utf8",
    );
  }

  private async mutation(operation: string, args: string[]): Promise<string> {
    const outputFile = path.join(this.artifactDirectory, `wrangler-${operation}.ndjson`);
    try {
      await access(outputFile);
      throw new FactoryError("provider_output_stale", `Refusing to reuse Wrangler output for '${operation}'.`);
    } catch (error) {
      if (error instanceof FactoryError) throw error;
    }
    const result = await this.run(args, outputFile);
    await this.persistLogs(operation, result);
    let raw = "";
    try {
      raw = await readFile(outputFile, "utf8");
    } catch {
      throw new FactoryError("provider_output_invalid", `Wrangler '${operation}' did not create structured output.`);
    }
    const sanitized = redact(raw, this.parentEnv);
    await writeFile(outputFile, sanitized, "utf8");
    if (result.timedOut || result.exitCode !== 0) {
      throw new FactoryError(
        result.timedOut ? "provider_timeout" : "provider_command_failed",
        `Wrangler '${operation}' failed: ${redact(result.stderr || result.stdout, this.parentEnv)}`,
      );
    }
    return sanitized;
  }

  async assertTargetExists(workerName: string): Promise<void> {
    const result = await this.run([
      "versions", "list", "--name", workerName, "--config", this.configPath(), "--json",
    ]);
    await this.persistLogs(`target-check-${++this.readSequence}`, result);
    if (result.timedOut || result.exitCode !== 0) {
      throw new FactoryError(
        "deployment_target_unconfigured",
        "Configured Cloudflare Worker could not be resolved. Provision the Worker and domain before delivery.",
      );
    }
    const parsed = parseJson(result.stdout, "provider_status_invalid");
    if (!Array.isArray(parsed)) {
      throw new FactoryError("provider_status_invalid", "Wrangler versions list output must be an array.");
    }
  }

  async upload(workerName: string): Promise<UploadedVersion> {
    const raw = await this.mutation("upload", [
      "versions", "upload", "--name", workerName, "--config", this.configPath(),
      "--experimental-auto-create=false", "--experimental-provision=false",
    ]);
    return parseVersionUpload(raw, workerName);
  }

  async currentProductionVersion(workerName: string): Promise<string | null> {
    const result = await this.run([
      "deployments", "list", "--name", workerName, "--config", this.configPath(), "--json",
    ]);
    await this.persistLogs(`status-${++this.readSequence}`, result);
    if (result.timedOut || result.exitCode !== 0) {
      throw new FactoryError("provider_status_failed", "Unable to query current Cloudflare production state.");
    }
    return parseCurrentVersion(result.stdout);
  }

  async promote(workerName: string, versionId: string): Promise<void> {
    const raw = await this.mutation("promote", [
      "versions", "deploy", `${versionId}@100%`, "-y", "--name", workerName, "--config", this.configPath(),
      "--experimental-auto-create=false", "--experimental-provision=false",
    ]);
    const record = singleRecord(parseNdjson(raw), "version-deploy");
    if (record.worker_name !== workerName) {
      throw new FactoryError("provider_identity_mismatch", "Wrangler promotion returned an unexpected Worker identity.");
    }
    const active = await this.currentProductionVersion(workerName);
    if (active !== versionId) {
      throw new FactoryError("version_promotion_mismatch", "Cloudflare did not activate the exact preview-verified version.");
    }
  }

  async rollback(workerName: string, versionId: string): Promise<void> {
    const result = await this.run([
      "rollback", versionId, "--name", workerName, "--config", this.configPath(),
      "--message", "Factory rollback to verified version",
    ]);
    await this.persistLogs("rollback", result);
    if (result.timedOut || result.exitCode !== 0) {
      throw new FactoryError("rollback_failed", "Cloudflare rollback command failed.");
    }
    const active = await this.currentProductionVersion(workerName);
    if (active !== versionId) {
      throw new FactoryError("rollback_mismatch", "Cloudflare did not activate the exact rollback version.");
    }
  }
}
