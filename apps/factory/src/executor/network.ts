import { FactoryError } from "./errors.js";
import { FACTORY_COLIMA_PROFILE, dockerClientEnv } from "./isolation.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

/**
 * Runtime egress allowlist (code-worker-routing-v0).
 *
 * The coding runtimes (kimi-code-cli / claude-code) have no reliable inner
 * network sandbox equivalent to the accepted Codex inner policy, so the
 * restriction is enforced at the OUTER boundary inside the dedicated Colima
 * VM: a dedicated Docker network whose subnet may only reach the model
 * gateway (openrouter.ai) plus established/related return traffic. DNS
 * resolution flows through Docker's embedded resolver inside each container
 * netns and is unaffected by FORWARD-chain rules.
 *
 * Rules are scoped with a Factory comment marker so only Factory-owned rules
 * are ever removed, and the functional probe (gateway reachable, arbitrary
 * host NOT reachable) proves the property rather than assuming it.
 */

export const FACTORY_RUNTIME_NETWORK = "factory-runtime-net";
export const OPENROUTER_EGRESS_HOST = "openrouter.ai";
/** iptables comment marker identifying Factory-owned DOCKER-USER rules. */
export const FACTORY_EGRESS_COMMENT = "factory-runtime-egress";

/** Timeout for each VM/docker interaction in the network setup and probes. */
const NETWORK_CMD_TIMEOUT_MS = 60_000;

export interface EgressRuleSpec {
  /** iptables arguments for one rule (without the -A/-I chain prefix). */
  args: string[];
}

/**
 * Pure rule builder: allow established/related outbound, allow the model
 * gateway IPs, drop everything else — all scoped to the dedicated subnet.
 * Order matters: accept rules must precede the drop rule.
 */
export function buildEgressRuleSpecs(subnet: string, allowedIps: readonly string[]): EgressRuleSpec[] {
  const scope = ["-s", subnet, "-m", "comment", "--comment", FACTORY_EGRESS_COMMENT];
  return [
    { args: [...scope, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"] },
    ...allowedIps.map((ip) => ({ args: [...scope, "-d", ip, "-j", "ACCEPT"] })),
    { args: [...scope, "-j", "DROP"] },
  ];
}

/**
 * Pure transformer: convert an `iptables -S DOCKER-USER` listing line into
 * the corresponding deletion command arguments. Returns null for lines that
 * are not Factory-owned (never touch foreign rules).
 */
export function iptablesSpecToDelete(listingLine: string): string[] | null {
  const trimmed = listingLine.trim();
  if (!trimmed.startsWith("-A DOCKER-USER ")) return null;
  if (!trimmed.includes(FACTORY_EGRESS_COMMENT)) return null;
  return ["-D", "DOCKER-USER", ...trimmed.replace(/^(-A)\s+DOCKER-USER\s+/, "").trim().split(/\s+/)];
}

export interface NetworkEnsureResult {
  subnet: string;
  allowedIps: string[];
}

export interface NetworkEnsureDeps {
  docker?: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
  vm?: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;
}

function parseNetworkSubnet(inspectJson: string): string | null {
  try {
    const parsed = JSON.parse(inspectJson) as Array<{ IPAM?: { Config?: Array<{ Subnet?: unknown }> } }>;
    const config = parsed[0]?.IPAM?.Config ?? [];
    for (const entry of config) {
      if (typeof entry.Subnet === "string" && entry.Subnet.length > 0) return entry.Subnet;
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseAhostsv4Ips(output: string): string[] {
  const ips = new Set<string>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const candidate = fields[0];
    if (candidate && /^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
      ips.add(candidate);
    }
  }
  return [...ips].sort();
}

/**
 * Ensure the dedicated runtime network + outer egress allowlist exist and
 * PROVE the property with functional probes. Idempotent; safe to call per
 * process. Fails closed on any verification error.
 */
export async function ensureRuntimeNetworkIsolation(
  repoRoot: string,
  deps: NetworkEnsureDeps = {},
): Promise<NetworkEnsureResult> {
  const docker = deps.docker ?? ((args: string[]) =>
    runProcess("docker", args, {
      cwd: repoRoot,
      env: dockerClientEnv(repoRoot),
      timeoutMs: NETWORK_CMD_TIMEOUT_MS,
    }));
  // Factory-owned VM commands run through sudo: the default Colima VM user
  // is unprivileged (iptables requires root inside the VM).
  const vm = deps.vm ?? ((args: string[]) =>
    runProcess("colima", ["ssh", "--profile", FACTORY_COLIMA_PROFILE, "--", "sudo", "--", ...args], {
      cwd: repoRoot,
      env: buildChildEnv(),
      timeoutMs: NETWORK_CMD_TIMEOUT_MS,
    }));

  // 1. Dedicated network exists (created without ICC between containers).
  const inspect = await docker(["network", "inspect", FACTORY_RUNTIME_NETWORK]).catch((error: unknown) => {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      `could not inspect runtime network: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (inspect.exitCode !== 0) {
    const created = await docker(["network", "create", "--attachable", "--internal=false", FACTORY_RUNTIME_NETWORK]);
    if (created.exitCode !== 0) {
      throw new FactoryError(
        "strong_execution_isolation_unavailable",
        `could not create runtime network: ${created.stderr.trim() || `exit ${created.exitCode}`}`,
      );
    }
  }
  const reinspect = inspect.exitCode === 0 ? inspect : await docker(["network", "inspect", FACTORY_RUNTIME_NETWORK]);
  const subnet = parseNetworkSubnet(reinspect.stdout);
  if (!subnet) {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      `runtime network ${FACTORY_RUNTIME_NETWORK} has no parsable subnet`,
    );
  }

  // 2. Resolve the model gateway from INSIDE the VM (the egress vantage point).
  const resolved = await vm(["getent", "ahostsv4", OPENROUTER_EGRESS_HOST]);
  if (resolved.exitCode !== 0) {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      `could not resolve ${OPENROUTER_EGRESS_HOST} inside the isolation VM: ${resolved.stderr.trim() || `exit ${resolved.exitCode}`}`,
    );
  }
  const allowedIps = parseAhostsv4Ips(resolved.stdout);
  if (allowedIps.length === 0) {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      `no usable IPv4 addresses resolved for ${OPENROUTER_EGRESS_HOST}`,
    );
  }

  // 3. Sync Factory-owned DOCKER-USER rules (remove ours, add fresh set).
  const listed = await vm(["iptables", "-w", "-S", "DOCKER-USER"]);
  if (listed.exitCode !== 0) {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      `could not list DOCKER-USER rules: ${listed.stderr.trim() || `exit ${listed.exitCode}`}`,
    );
  }
  for (const line of listed.stdout.split("\n")) {
    const del = iptablesSpecToDelete(line);
    if (!del) continue;
    const removed = await vm(["iptables", "-w", ...del]);
    if (removed.exitCode !== 0) {
      throw new FactoryError(
        "strong_execution_isolation_unavailable",
        `could not remove stale egress rule: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`,
      );
    }
  }
  for (const spec of buildEgressRuleSpecs(subnet, allowedIps)) {
    const added = await vm(["iptables", "-w", "-A", "DOCKER-USER", ...spec.args]);
    if (added.exitCode !== 0) {
      throw new FactoryError(
        "strong_execution_isolation_unavailable",
        `could not install egress rule: ${added.stderr.trim() || `exit ${added.exitCode}`}`,
      );
    }
  }

  // 4. Functional probes: model gateway reachable, arbitrary host denied.
  const probeScript = (url: string) =>
    `node -e "fetch('${url}',{signal:AbortSignal.timeout(20000)}).then(r=>{console.log('HTTP',r.status);process.exit(0)}).catch(e=>{console.log('ERR',e.message);process.exit(1)})"`;
  const gatewayProbe = await docker([
    "run", "--rm", "--network", FACTORY_RUNTIME_NETWORK, "-e", "OPENROUTER_PROBE=1",
    "node:22-bookworm-slim",
    "/bin/sh", "-c", probeScript("https://openrouter.ai/api/v1/models"),
  ]);
  if (gatewayProbe.exitCode !== 0) {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      `model gateway probe failed through the runtime network (fail closed): ${gatewayProbe.stdout.trim()} ${gatewayProbe.stderr.trim()}`.slice(0, 400),
    );
  }
  const denyProbe = await docker([
    "run", "--rm", "--network", FACTORY_RUNTIME_NETWORK,
    "node:22-bookworm-slim",
    "/bin/sh", "-c", probeScript("https://example.com"),
  ]);
  if (denyProbe.exitCode === 0) {
    throw new FactoryError(
      "strong_execution_isolation_unavailable",
      "egress deny probe FAILED: arbitrary internet access is reachable from the runtime network (fail closed)",
    );
  }

  return { subnet, allowedIps };
}
