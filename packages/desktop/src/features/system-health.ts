import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";

export type SystemServiceStatus = "ok" | "warn" | "error" | "unknown";

export interface SystemServiceNode {
  id: string;
  name: string;
  status: SystemServiceStatus;
  summary: string;
  detail?: string;
  children?: SystemServiceNode[];
}

export interface SystemHealthSnapshot {
  timestamp: number;
  cpu: {
    percent: number;
    cores: number;
    loadAvg1m: number;
  };
  memory: {
    usedBytes: number;
    totalBytes: number;
    percent: number;
  };
  disk: {
    mount: string;
    usedBytes: number;
    freeBytes: number;
    totalBytes: number;
    percent: number;
  } | null;
  services: SystemServiceNode[];
}

export interface SystemHealthDeps {
  platform?: NodeJS.Platform;
  cpus?: () => os.CpuInfo[];
  loadavg?: () => number[];
  totalmem?: () => number;
  freemem?: () => number;
  statfs?: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
  execCommand?: (
    command: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string } | null>;
  fetchJson?: (url: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

interface CpuSample {
  idle: number;
  total: number;
}

let previousCpuSample: CpuSample | null = null;
let inflightSnapshot: Promise<SystemHealthSnapshot> | null = null;

export function resetCpuSampleForTest(): void {
  previousCpuSample = null;
}

function buildCommandEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extraPaths = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    "/usr/bin",
    "/bin",
  ];
  const current = process.env.PATH ?? "";
  const parts = current.split(":").filter(Boolean);
  for (const p of extraPaths) {
    if (!parts.includes(p)) {
      parts.push(p);
    }
  }
  return { ...process.env, PATH: parts.join(":") };
}

function defaultExecCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string } | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 256 * 1024,
        env: buildCommandEnv(),
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

async function defaultFetchJson(
  url: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sampleCpu(cpusFn: () => os.CpuInfo[], loadavgFn: () => number[]): SystemHealthSnapshot["cpu"] {
  const list = cpusFn();
  const cores = Math.max(1, list.length);
  const loadAvg1m = Number((loadavgFn()[0] ?? 0).toFixed(2));

  let idle = 0;
  let total = 0;
  for (const cpu of list) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  let percent: number;
  if (previousCpuSample && total > previousCpuSample.total) {
    const idleDelta = idle - previousCpuSample.idle;
    const totalDelta = total - previousCpuSample.total;
    percent = clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
  } else {
    percent = clampPercent((loadAvg1m / cores) * 100);
  }

  previousCpuSample = { idle, total };
  return { percent, cores, loadAvg1m };
}

export function parseMacVmStatUsedBytes(stdout: string): number | null {
  const pageSizeMatch = stdout.match(/page size of (\d+) bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

  const readPages = (label: string): number => {
    const re = new RegExp(`${label}:\\s+(\\d+)\\.`, "i");
    const match = stdout.match(re);
    return match ? Number(match[1]) : 0;
  };

  const active = readPages("Pages active");
  const wired = readPages("Pages wired down");
  const compressed = readPages("Pages occupied by compressor");
  const usedPages = active + wired + compressed;
  if (usedPages <= 0) return null;
  return usedPages * pageSize;
}

async function sampleMemory(
  platform: NodeJS.Platform,
  totalmemFn: () => number,
  freememFn: () => number,
  execCommand: NonNullable<SystemHealthDeps["execCommand"]>,
): Promise<SystemHealthSnapshot["memory"]> {
  const totalBytes = Math.max(1, totalmemFn());
  let usedBytes: number | null = null;

  if (platform === "darwin") {
    const res = await execCommand("vm_stat", [], 800);
    if (res?.stdout) {
      usedBytes = parseMacVmStatUsedBytes(res.stdout);
    }
  }

  if (usedBytes === null) {
    usedBytes = Math.max(0, totalBytes - freememFn());
  }

  const clampedUsed = Math.min(totalBytes, Math.max(0, usedBytes));
  return {
    usedBytes: clampedUsed,
    totalBytes,
    percent: clampPercent((clampedUsed / totalBytes) * 100),
  };
}

async function sampleDisk(
  statfsFn: NonNullable<SystemHealthDeps["statfs"]>,
): Promise<SystemHealthSnapshot["disk"]> {
  try {
    const mount = "/";
    const stats = await statfsFn(mount);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return null;
    }
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      mount,
      usedBytes,
      freeBytes: Math.max(0, freeBytes),
      totalBytes,
      percent: clampPercent((usedBytes / totalBytes) * 100),
    };
  } catch {
    return null;
  }
}

function formatCompactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}k`;
  return String(count);
}

interface WxWorkDaemonData {
  ready?: boolean;
  syncing?: boolean;
  rebuilding?: boolean;
  captured?: number;
  last_error?: string | null;
  service?: {
    running?: boolean;
    installed?: boolean;
    elasticsearch_available?: boolean;
    last_error?: string | null;
    container?: string;
  };
}

async function sampleWxWorkService(
  execCommand: NonNullable<SystemHealthDeps["execCommand"]>,
  fetchJson: NonNullable<SystemHealthDeps["fetchJson"]>,
): Promise<SystemServiceNode | null> {
  const [daemonRes, esHealth] = await Promise.all([
    execCommand("wxwork", ["daemon", "status"], 1200),
    fetchJson("http://127.0.0.1:9200/_cluster/health", 700),
  ]);

  if (!daemonRes && !esHealth) {
    return null;
  }

  let data: WxWorkDaemonData | null = null;
  if (daemonRes?.stdout) {
    try {
      const parsed = JSON.parse(daemonRes.stdout) as { data?: WxWorkDaemonData };
      data = parsed.data ?? null;
    } catch {
      data = null;
    }
  }

  const esClusterStatus = typeof esHealth?.status === "string" ? esHealth.status : null;
  const esActiveShards =
    typeof esHealth?.active_primary_shards === "number" ? esHealth.active_primary_shards : null;
  const esReportedAvailable = data?.service?.elasticsearch_available;

  const esNode: SystemServiceNode = (() => {
    if (esClusterStatus === "green") {
      return {
        id: "wxwork-es",
        name: "es",
        status: "ok",
        summary: "",
        detail:
          esActiveShards !== null
            ? `Elasticsearch healthy · ${esActiveShards} primary shards`
            : "Elasticsearch healthy",
      };
    }
    if (esClusterStatus === "yellow") {
      return {
        id: "wxwork-es",
        name: "es",
        status: "warn",
        summary: "degraded",
        detail:
          esActiveShards !== null
            ? `Elasticsearch yellow · ${esActiveShards} primary shards`
            : "Elasticsearch yellow",
      };
    }
    if (esClusterStatus === "red") {
      return {
        id: "wxwork-es",
        name: "es",
        status: "error",
        summary: "red",
        detail: "Elasticsearch cluster status is red",
      };
    }
    if (esReportedAvailable === false || esClusterStatus === null) {
      return {
        id: "wxwork-es",
        name: "es",
        status: "error",
        summary: "offline",
        detail: data?.service?.last_error ?? "Elasticsearch unreachable on 127.0.0.1:9200",
      };
    }
    return {
      id: "wxwork-es",
      name: "es",
      status: "unknown",
      summary: "unknown",
    };
  })();

  const daemonRunning = data?.service?.running === true;
  const daemonReady = data?.ready === true;
  const daemonSyncing = data?.syncing === true;
  const daemonRebuilding = data?.rebuilding === true;
  const captured = typeof data?.captured === "number" ? data.captured : null;
  const lastError = data?.last_error ?? data?.service?.last_error ?? null;

  let status: SystemServiceStatus;
  let summary: string;

  if (!data || !daemonRunning) {
    status = "error";
    summary = "stopped";
  } else if (esNode.status === "error") {
    status = "error";
    summary = "es offline";
  } else if (daemonRebuilding) {
    status = "warn";
    summary = "rebuilding";
  } else if (!daemonReady) {
    status = "warn";
    summary = daemonSyncing ? "syncing" : "starting";
  } else if (esNode.status === "warn") {
    status = "warn";
    summary = captured !== null ? formatCompactCount(captured) : "";
  } else {
    status = "ok";
    summary = captured !== null ? formatCompactCount(captured) : "";
  }

  const detailParts = [
    daemonRunning ? "daemon running" : "daemon stopped",
    daemonReady ? "ready" : null,
    daemonSyncing ? "syncing" : null,
    captured !== null ? `${captured.toLocaleString()} msgs` : null,
    lastError ? `error: ${lastError}` : null,
  ].filter(Boolean);

  return {
    id: "wxwork",
    name: "wxwork",
    status,
    summary,
    detail: detailParts.join(" · "),
    children: [esNode],
  };
}

interface PodmanMachineEntry {
  Name?: string;
  Default?: boolean;
  Running?: boolean;
  Starting?: boolean;
  Memory?: string | number;
  CPUs?: number;
}

async function samplePodmanService(
  execCommand: NonNullable<SystemHealthDeps["execCommand"]>,
): Promise<SystemServiceNode | null> {
  const res = await execCommand("podman", ["machine", "list", "--format", "json"], 1000);
  if (!res?.stdout) return null;

  let machines: PodmanMachineEntry[];
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    machines = parsed as PodmanMachineEntry[];
  } catch {
    return null;
  }

  const target = machines.find((m) => m.Default) ?? machines[0];
  if (!target) return null;

  const memBytes = Number(target.Memory ?? 0);
  const memLabel =
    Number.isFinite(memBytes) && memBytes > 0
      ? `${Math.round(memBytes / (1024 ** 3))}G VM`
      : null;

  if (target.Running) {
    return {
      id: "podman",
      name: "podman",
      status: "ok",
      summary: memLabel ?? "",
      detail: [
        target.Name ?? "podman-machine",
        target.CPUs ? `${target.CPUs} vCPU` : null,
        memLabel,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  if (target.Starting) {
    return {
      id: "podman",
      name: "podman",
      status: "warn",
      summary: "starting",
      detail: `${target.Name ?? "podman-machine"} is starting`,
    };
  }

  return {
    id: "podman",
    name: "podman",
    status: "warn",
    summary: "stopped",
    detail: `${target.Name ?? "podman-machine"} is stopped`,
  };
}

export async function collectSystemHealth(
  deps: SystemHealthDeps = {},
): Promise<SystemHealthSnapshot> {
  const platform = deps.platform ?? process.platform;
  const cpusFn = deps.cpus ?? os.cpus;
  const loadavgFn = deps.loadavg ?? os.loadavg;
  const totalmemFn = deps.totalmem ?? os.totalmem;
  const freememFn = deps.freemem ?? os.freemem;
  const statfsFn = deps.statfs ?? ((p: string) => statfs(p));
  const execCommand = deps.execCommand ?? defaultExecCommand;
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const now = deps.now ?? Date.now;

  const cpu = sampleCpu(cpusFn, loadavgFn);
  const [memory, disk, wxwork, podman] = await Promise.all([
    sampleMemory(platform, totalmemFn, freememFn, execCommand),
    sampleDisk(statfsFn),
    sampleWxWorkService(execCommand, fetchJson),
    samplePodmanService(execCommand),
  ]);

  const services: SystemServiceNode[] = [];
  if (wxwork) services.push(wxwork);
  if (podman) services.push(podman);

  return {
    timestamp: now(),
    cpu,
    memory,
    disk,
    services,
  };
}

export function getSystemHealth(): Promise<SystemHealthSnapshot> {
  if (!inflightSnapshot) {
    inflightSnapshot = collectSystemHealth().finally(() => {
      inflightSnapshot = null;
    });
  }
  return inflightSnapshot;
}
