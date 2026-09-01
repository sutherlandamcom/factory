import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { FactoryError } from "./errors.js";
import {
  KIMI_VERSION,
  KIMI_WORKER_IMAGE,
  assertStrongExecutionIsolationAvailable,
  dockerClientEnv,
} from "./isolation.js";
import { FACTORY_RUNTIME_NETWORK, OPENROUTER_EGRESS_HOST } from "./network.js";
import { loadOpenRouterApiKey, OPENROUTER_GATEWAY_BASE_URL } from "../models/gateway.js";
import { codeWorkerBinding } from "../models/policy.js";
import { runProcess } from "./process.js";
import { startModelRelay } from "./relay.js";
import { extractRespondedModel, type CodeWorkerRuntime } from "./runtime.js";

/**
 * Kimi Code CLI runtime adapter (Factory primary code worker).
 *
 * Trust and security properties (must never be weakened):
 * - Strong outer isolation is asserted before first use (dedicated Colima
 *   QEMU VM + hardened ephemeral Docker worker). The Kimi Code CLI has NO
 *   inner namespace sandbox equivalent to Codex's bubblewrap; the outer
 *   boundary is therefore authoritative and the container runs under the
 *   DEFAULT hardened seccomp profile (no unconfined exceptions).
 * - The container runs non-root, read-only-rootfs, capability-free,
 *   no-new-privileges, resource-bounded, with the worktree mounted
 *   read-only except the exact writable parent paths.
 * - Credentials: The worker container has NO real OPENROUTER_API_KEY. All
 *   model requests route through the trusted local Factory model relay, which
 *   owns the real API key and enforces model binding (moonshotai/kimi-k3).
 *   The container receives only an ephemeral dummy authorization token.
 *   No host HOME, no host Kimi configuration, no other credentials.
 * - Network: only the model relay is reachable; web/search/fetch/MCP tools are
 *   disabled in the Factory config as defense in depth.
 * - Provenance: requestedModel/reasoningEffort come from the Factory
 *   policy; respondedModel is extracted from runtime events when genuinely
 *   present, otherwise null — never invented.
 */

const KIMI_HOME_DIR = "/tmp/home/.kimi-code";

/** Pure builder for the ephemeral Kimi Code config (unit-tested). */
export function buildKimiConfigToml(params: {
  apiKey: string;
  model: string;
  openrouterBaseUrl: string;
  reasoningEffort: string;
}): string {
  return `# Factory-generated ephemeral Kimi Code configuration (${KIMI_WORKER_IMAGE}).
# Materialized per-run by Factory, mounted read-only, deleted after the run.
# The operator must never rely on host-global Kimi configuration.
default_model = "factory-openrouter/kimi-k3"
default_permission_mode = "auto"
merge_all_available_skills = false
telemetry = false

[providers.factory-openrouter]
type = "openai"
base_url = "${params.openrouterBaseUrl}"
api_key = "${params.apiKey}"

[models."factory-openrouter/kimi-k3"]
provider = "factory-openrouter"
model = "${params.model}"
max_context_size = 262144
capabilities = ["thinking", "tool_use"]
display_name = "Kimi K3 (Factory primary)"
support_efforts = ["${params.reasoningEffort}"]
default_effort = "${params.reasoningEffort}"

[thinking]
enabled = true
effort = "${params.reasoningEffort}"
keep = "all"

[loop_control]
max_attempts_per_step = 10
reserved_context_size = 50000

[tools]
# Arbitrary web access, arbitrary MCP servers, and arbitrary subagents are
# disabled for Factory SiteTask execution; the outer network boundary is
# authoritative regardless.
disabled = [
  "WebSearch", "WebFetch", "web_search", "web_fetch", "browser",
  "mcp__*", "Task", "Agent", "EnterPlanMode", "ExitPlanMode",
]
`;
}

function safeContainerName(runDir: string): string {
  const base = path.basename(path.dirname(runDir)).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 38);
  return `factory-kimi-${base}-${randomBytes(4).toString("hex")}`;
}

export function buildKimiContainerArgs(
  request: Parameters<CodeWorkerRuntime>[0],
  containerName: string,
  runtimeDir: string,
): string[] {
  const containerUid = process.getuid?.() ?? 1000;
  const containerGid = process.getgid?.() ?? 1000;
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--name",
    containerName,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    // Dedicated allowlist-only network: DOCKER-USER egress rules permit
    // model-gateway connectivity and deny everything else (outer boundary).
    "--network",
    FACTORY_RUNTIME_NETWORK,
    "--user",
    `${containerUid}:${containerGid}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
    "--env",
    "HOME=/tmp/home",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    `KIMI_CODE_HOME=${KIMI_HOME_DIR}`,
    "--mount",
    `type=bind,src=${request.worktreePath},dst=/workspace${request.workspaceWritable ? "" : ",readonly"}`,
  ];
  if (!request.workspaceWritable) {
    const writableParents = [...new Set(request.writablePaths.map((relativePath) => path.dirname(relativePath)))];
    for (const relativeParent of writableParents) {
      args.push(
        "--mount",
        `type=bind,src=${path.join(request.worktreePath, relativeParent)},dst=${path.posix.join("/workspace", relativeParent)}`,
      );
    }
  }
  args.push(
    "--mount",
    `type=bind,src=${path.join(runtimeDir, "config")},dst=/kimi-config,readonly`,
    "--mount",
    `type=bind,src=${path.join(runtimeDir, "output")},dst=/output`,
    "--workdir",
    "/workspace",
    KIMI_WORKER_IMAGE,
  );
  return args;
}

/** Strong production runner: Colima VM → hardened Docker worker → Kimi Code CLI. */
export function createKimiCodeRunner(opts: { repoRoot: string }): CodeWorkerRuntime {
  let isolationReady: Promise<void> | undefined;
  return async (request) => {
    isolationReady ??= (async () => {
      await assertStrongExecutionIsolationAvailable(opts.repoRoot);
    })();
    await isolationReady;

    const binding = codeWorkerBinding("primary");
    if (binding.runtime !== "kimi-code-cli") {
      throw new FactoryError(
        "routing_violation",
        `kimi runtime adapter selected but policy primary runtime is ${binding.runtime}`,
      );
    }

    const apiKey = loadOpenRouterApiKey();
    if (apiKey === null) {
      throw new FactoryError(
        "kimi_credentials_unavailable",
        "OPENROUTER_API_KEY is not configured; the kimi-code-cli runtime fails closed without credentials",
      );
    }

    const containerName = safeContainerName(request.runDir);
    const relay = await startModelRelay({
      tier: "primary",
      apiKey,
      repoRoot: opts.repoRoot,
      containerName,
    });

    const runtimeRoot = path.join(opts.repoRoot, ".factory", "kimi-runtime");
    const runtimeDir = path.join(runtimeRoot, containerName);
    const configDir = path.join(runtimeDir, "config");
    const outputDir = path.join(runtimeDir, "output");

    for (const relativePath of request.writablePaths) {
      const absolute = path.resolve(request.worktreePath, relativePath);
      const relative = path.relative(request.worktreePath, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new FactoryError("scope_violation", `${relativePath}: writable path escapes worktree`);
      }
      await mkdir(path.dirname(absolute), { recursive: true });
    }

    try {
      await mkdir(configDir, { recursive: true });
      await mkdir(outputDir, { recursive: true });
      // The config points to the local Factory model relay with an ephemeral random token.
      // The real OPENROUTER_API_KEY is never mounted or passed into the container.
      const configPath = path.join(configDir, "config.toml");
      await writeFile(
        configPath,
        buildKimiConfigToml({
          apiKey: relay.relayToken,
          model: binding.model,
          openrouterBaseUrl: relay.baseUrl,
          reasoningEffort: binding.reasoningEffort ?? "max",
        }),
        { mode: 0o600 },
      );
      await chmod(configPath, 0o600);

      const args = buildKimiContainerArgs(request, containerName, runtimeDir);
      const result = await runProcess("docker", args, {
        cwd: opts.repoRoot,
        env: dockerClientEnv(opts.repoRoot),
        timeoutMs: request.timeoutMs,
        input: request.prompt,
      });

      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        runtimeVersion: `kimi-code-cli ${KIMI_VERSION}`,
        requestedModel: binding.model,
        respondedModel: extractRespondedModel(result.stdout),
        provider: "openrouter",
        reasoningEffort: binding.reasoningEffort,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      await relay.close().catch(() => undefined);
      await runProcess("docker", ["rm", "--force", containerName], {
        cwd: opts.repoRoot,
        env: dockerClientEnv(opts.repoRoot),
        timeoutMs: 30_000,
      }).catch(() => undefined);
      // Removes the ephemeral config directory. Never skip.
      await rm(runtimeDir, { recursive: true, force: true });
    }
  };
}

export { OPENROUTER_EGRESS_HOST };
