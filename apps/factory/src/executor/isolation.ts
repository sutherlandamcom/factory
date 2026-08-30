import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FactoryError } from "./errors.js";
import { buildChildEnv } from "./env.js";
import { runProcess } from "./process.js";

export const STRONG_EXECUTION_ISOLATION_UNAVAILABLE =
  "STRONG_EXECUTION_ISOLATION_UNAVAILABLE";
export const FACTORY_COLIMA_PROFILE = "factory-sandbox";
export const CODEX_WORKER_IMAGE = "factory-codex-worker:0.150.1";
export const CODEX_VERSION = "0.150.1";
export const CODEX_WORKER_REVISION = "2";

const PREFLIGHT_TIMEOUT_MS = 120_000;

export function codexWorkerBuildArgs(repoRoot: string): string[] {
  const context = path.join(repoRoot, "apps", "factory", "isolation");
  return [
    "build",
    "--pull",
    "--file",
    path.join(context, "codex-worker.Dockerfile"),
    "--tag",
    CODEX_WORKER_IMAGE,
    "--build-arg",
    `CODEX_VERSION=${CODEX_VERSION}`,
    context,
  ];
}

function isolationError(detail: string): FactoryError {
  return new FactoryError(
    "strong_execution_isolation_unavailable",
    `${STRONG_EXECUTION_ISOLATION_UNAVAILABLE}: ${detail}`,
  );
}

export function colimaHome(parent: NodeJS.ProcessEnv = process.env): string {
  return parent.COLIMA_HOME ?? path.join(parent.HOME ?? os.homedir(), ".colima");
}

export function colimaProfileConfigPath(parent: NodeJS.ProcessEnv = process.env): string {
  return path.join(colimaHome(parent), FACTORY_COLIMA_PROFILE, "colima.yaml");
}

export function colimaDockerHost(parent: NodeJS.ProcessEnv = process.env): string {
  return `unix://${path.join(colimaHome(parent), FACTORY_COLIMA_PROFILE, "docker.sock")}`;
}

export function expectedColimaMounts(repoRoot: string): string[] {
  return [
    path.join(repoRoot, ".factory", "codex-runtime"),
    path.join(repoRoot, ".factory", "worktrees"),
  ].sort();
}

/** Extract only host mount locations from Colima's generated YAML. */
export function parseColimaMountLocations(yaml: string): string[] {
  const locations: string[] = [];
  let inMounts = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^mounts:\s*$/.test(line)) {
      inMounts = true;
      continue;
    }
    if (inMounts && /^\S/.test(line) && line.trim() !== "") break;
    if (!inMounts) continue;
    const match = /^\s*-?\s*location:\s*(.+?)\s*$/.exec(line);
    if (match) locations.push(match[1]!.replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
  }
  return locations.sort();
}

export function parseFindmntTargets(json: string): string[] {
  type FindmntEntry = { target?: unknown; children?: FindmntEntry[] };
  const parsed = JSON.parse(json) as { filesystems?: FindmntEntry[] };
  if (!Array.isArray(parsed.filesystems)) throw new Error("findmnt result has no filesystems array");
  const targets: string[] = [];
  const visit = (entries: FindmntEntry[]) => {
    for (const entry of entries) {
      if (typeof entry.target === "string") targets.push(entry.target);
      if (Array.isArray(entry.children)) visit(entry.children);
    }
  };
  visit(parsed.filesystems);
  return targets.sort();
}

function topLevelScalar(yaml: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(yaml);
  return match?.[1];
}

function sectionScalar(yaml: string, section: string, key: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    if (line === `${section}:`) {
      inSection = true;
      continue;
    }
    if (inSection && /^\S/.test(line) && line.trim() !== "") break;
    if (!inSection) continue;
    const match = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`).exec(line);
    if (match) return match[1];
  }
  return undefined;
}

export function dockerClientEnv(
  repoRoot: string,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildChildEnv(parent, {
    DOCKER_HOST: colimaDockerHost(parent),
    DOCKER_CONFIG: path.join(repoRoot, ".factory", "codex-runtime", "docker-config"),
  });
}

export async function assertStrongExecutionIsolationAvailable(repoRoot: string): Promise<void> {
  const runtimeRoot = path.join(repoRoot, ".factory", "codex-runtime");
  const dockerConfigDir = path.join(runtimeRoot, "docker-config");
  await mkdir(dockerConfigDir, { recursive: true });
  await mkdir(path.join(repoRoot, ".factory", "worktrees"), { recursive: true });

  for (const runtimePath of [...expectedColimaMounts(repoRoot), dockerConfigDir]) {
    const stat = await lstat(runtimePath).catch((error: unknown) => {
      throw isolationError(`runtime path is unavailable: ${runtimePath} (${error instanceof Error ? error.message : String(error)})`);
    });
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(runtimePath) !== runtimePath) {
      throw isolationError(`runtime path must be a real, non-symlink directory: ${runtimePath}`);
    }
  }

  let yaml: string;
  try {
    yaml = await readFile(colimaProfileConfigPath(), "utf8");
  } catch (error) {
    throw isolationError(`dedicated Colima profile ${FACTORY_COLIMA_PROFILE} is not configured (${error instanceof Error ? error.message : String(error)})`);
  }

  const actualMounts = parseColimaMountLocations(yaml);
  const expectedMounts = expectedColimaMounts(repoRoot);
  if (JSON.stringify(actualMounts) !== JSON.stringify(expectedMounts)) {
    throw isolationError(
      `Colima mount policy mismatch; expected only ${JSON.stringify(expectedMounts)}, got ${JSON.stringify(actualMounts)}`,
    );
  }
  if (topLevelScalar(yaml, "runtime") !== "docker") {
    throw isolationError("dedicated Colima profile is not using the Docker runtime");
  }
  if (topLevelScalar(yaml, "vmType") !== "qemu") {
    throw isolationError("dedicated Colima profile is not using the required qemu VM boundary");
  }
  if (sectionScalar(yaml, "kubernetes", "enabled") !== "false") {
    throw isolationError("dedicated Colima profile does not explicitly disable Kubernetes");
  }
  if (topLevelScalar(yaml, "forwardAgent") !== "false") {
    throw isolationError("dedicated Colima profile does not explicitly disable SSH-agent forwarding");
  }
  if (topLevelScalar(yaml, "sshConfig") !== "false") {
    throw isolationError("dedicated Colima profile does not explicitly disable host SSH-config mutation");
  }
  if (topLevelScalar(yaml, "autoActivate") !== "false") {
    throw isolationError("dedicated Colima profile may alter the general Docker context");
  }
  if (topLevelScalar(yaml, "portForwarder") !== "none") {
    throw isolationError("dedicated Colima profile must disable host port forwarding");
  }

  const findmnt = await runProcess(
    "colima",
    ["ssh", "--profile", FACTORY_COLIMA_PROFILE, "--", "findmnt", "--json", "--output", "TARGET"],
    { cwd: repoRoot, env: buildChildEnv(), timeoutMs: PREFLIGHT_TIMEOUT_MS },
  ).catch((error: unknown) => {
    throw isolationError(`could not inspect effective VM mounts: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (findmnt.timedOut || findmnt.exitCode !== 0) {
    throw isolationError(`could not inspect effective VM mounts: ${findmnt.stderr.trim() || `exit ${findmnt.exitCode}`}`);
  }
  let effectiveTargets: string[];
  try {
    effectiveTargets = parseFindmntTargets(findmnt.stdout);
  } catch (error) {
    throw isolationError(`could not parse effective VM mounts: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const expected of expectedMounts) {
    if (!effectiveTargets.includes(expected)) {
      throw isolationError(`expected VM mount is not effective: ${expected}`);
    }
  }
  for (const forbidden of [path.dirname(repoRoot), repoRoot, os.homedir(), "/Users"]) {
    if (!expectedMounts.includes(forbidden) && effectiveTargets.includes(forbidden)) {
      throw isolationError(`broad host path is mounted into the VM: ${forbidden}`);
    }
  }

  const userNamespacePolicy = await runProcess(
    "colima",
    ["ssh", "--profile", FACTORY_COLIMA_PROFILE, "--", "cat", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns"],
    { cwd: repoRoot, env: buildChildEnv(), timeoutMs: PREFLIGHT_TIMEOUT_MS },
  );
  if (
    userNamespacePolicy.timedOut
    || userNamespacePolicy.exitCode !== 0
    || userNamespacePolicy.stdout.trim() !== "0"
  ) {
    throw isolationError(
      "dedicated VM does not permit the unprivileged user namespaces required by the inner Codex sandbox",
    );
  }

  const info = await runProcess("docker", ["info", "--format", "{{.ServerVersion}}|{{.OSType}}"], {
    cwd: repoRoot,
    env: dockerClientEnv(repoRoot),
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  }).catch((error: unknown) => {
    throw isolationError(`Docker CLI could not reach ${FACTORY_COLIMA_PROFILE}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (info.timedOut || info.exitCode !== 0) {
    throw isolationError(`Docker server unavailable for ${FACTORY_COLIMA_PROFILE}: ${info.stderr.trim() || `exit ${info.exitCode}`}`);
  }
  const [serverVersion, osType] = info.stdout.trim().split("|");
  if (!serverVersion || osType !== "linux") {
    throw isolationError(`unexpected Docker server identity ${JSON.stringify(info.stdout.trim())}`);
  }

  const runningContainers = await runProcess(
    "docker",
    ["ps", "--quiet"],
    { cwd: repoRoot, env: dockerClientEnv(repoRoot), timeoutMs: PREFLIGHT_TIMEOUT_MS },
  );
  if (runningContainers.timedOut || runningContainers.exitCode !== 0) {
    throw isolationError(`could not inspect existing containers: ${runningContainers.stderr.trim() || `exit ${runningContainers.exitCode}`}`);
  }
  if (runningContainers.stdout.trim() !== "") {
    throw isolationError("dedicated isolation profile already has a running container");
  }

  const inspect = await runProcess(
    "docker",
    ["image", "inspect", CODEX_WORKER_IMAGE, "--format", "{{index .Config.Labels \"org.factory.codex.version\"}}|{{index .Config.Labels \"org.factory.worker.revision\"}}"],
    { cwd: repoRoot, env: dockerClientEnv(repoRoot), timeoutMs: PREFLIGHT_TIMEOUT_MS },
  );
  if (inspect.exitCode === 0 && inspect.stdout.trim() === `${CODEX_VERSION}|${CODEX_WORKER_REVISION}`) return;

  const build = await runProcess(
    "docker",
    codexWorkerBuildArgs(repoRoot),
    { cwd: repoRoot, env: dockerClientEnv(repoRoot), timeoutMs: 900_000 },
  );
  if (build.timedOut || build.exitCode !== 0) {
    throw isolationError(`failed to build pinned Codex worker image: ${build.stderr.trim() || `exit ${build.exitCode}`}`);
  }
}
