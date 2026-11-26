import { beforeEach, describe, expect, it } from "vitest";
import {
  collectSystemHealth,
  parseMacVmStatUsedBytes,
  resetCpuSampleForTest,
} from "./system-health";

describe("parseMacVmStatUsedBytes", () => {
  it("sums active, wired, and compressed pages using reported page size", () => {
    const sample = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                4341.",
      "Pages active:                            100000.",
      "Pages inactive:                          200000.",
      "Pages wired down:                         50000.",
      "Pages occupied by compressor:             25000.",
    ].join("\n");

    expect(parseMacVmStatUsedBytes(sample)).toBe((100000 + 50000 + 25000) * 16384);
  });

  it("returns null for empty or invalid output", () => {
    expect(parseMacVmStatUsedBytes("")).toBeNull();
  });
});

describe("collectSystemHealth", () => {
  beforeEach(() => {
    resetCpuSampleForTest();
  });

  it("computes cpu delta, macOS memory, disk, and wxwork -> ES tree", async () => {
    let cpuTick = 0;
    const cpus = () => {
      cpuTick += 1;
      const busy = cpuTick === 1 ? 100 : 150;
      const idle = cpuTick === 1 ? 300 : 350;
      return [
        {
          model: "Apple M3",
          speed: 3500,
          times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
        },
      ];
    };

    const deps = {
      platform: "darwin" as const,
      cpus,
      loadavg: () => [0.25, 0.2, 0.15],
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 1 * 1024 ** 3,
      statfs: async () => ({
        bsize: 4096,
        blocks: 250_000_000,
        bavail: 25_000_000,
      }),
      execCommand: async (command: string) => {
        if (command === "vm_stat") {
          return {
            stdout: [
              "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
              "Pages active: 300000.",
              "Pages wired down: 100000.",
              "Pages occupied by compressor: 124288.",
            ].join("\n"),
            stderr: "",
          };
        }
        if (command === "wxwork") {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                ready: true,
                syncing: true,
                captured: 550531,
                last_error: null,
                service: {
                  running: true,
                  elasticsearch_available: true,
                  last_error: null,
                },
              },
            }),
            stderr: "",
          };
        }
        if (command === "podman") {
          return {
            stdout: JSON.stringify([
              {
                Name: "podman-machine-default",
                Default: true,
                Running: true,
                Starting: false,
                CPUs: 8,
                Memory: String(16 * 1024 ** 3),
              },
            ]),
            stderr: "",
          };
        }
        return null;
      },
      fetchJson: async () => ({ status: "green", active_primary_shards: 5 }),
      now: () => 1700000000000,
    };

    const first = await collectSystemHealth(deps);
    expect(first.cpu.percent).toBe(25);
    expect(first.memory.percent).toBe(50);
    expect(first.disk?.percent).toBe(90);
    expect(first.services).toHaveLength(2);
    expect(first.services[0]).toMatchObject({
      id: "wxwork",
      name: "wxwork",
      status: "ok",
      summary: "551k",
      children: [
        {
          id: "wxwork-es",
          name: "es",
          status: "ok",
          summary: "",
        },
      ],
    });
    expect(first.services[1]).toMatchObject({
      id: "podman",
      name: "podman",
      status: "ok",
      summary: "16G VM",
    });

    const second = await collectSystemHealth(deps);
    // Delta busy = 50, delta idle = 50 -> 50%
    expect(second.cpu.percent).toBe(50);
  });

  it("marks wxwork error when ES is offline", async () => {
    const snapshot = await collectSystemHealth({
      platform: "linux",
      cpus: () => [{ model: "x", speed: 1, times: { user: 10, nice: 0, sys: 0, idle: 90, irq: 0 } }],
      loadavg: () => [0.5, 0.5, 0.5],
      totalmem: () => 8 * 1024 ** 3,
      freemem: () => 4 * 1024 ** 3,
      statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 500 }),
      execCommand: async (command) => {
        if (command === "wxwork") {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                ready: false,
                syncing: false,
                service: {
                  running: true,
                  elasticsearch_available: false,
                  last_error: "exit code 137",
                },
              },
            }),
            stderr: "",
          };
        }
        return null;
      },
      fetchJson: async () => null,
    });

    expect(snapshot.services).toHaveLength(1);
    expect(snapshot.services[0]?.status).toBe("error");
    expect(snapshot.services[0]?.summary).toBe("es offline");
    expect(snapshot.services[0]?.children?.[0]).toMatchObject({
      name: "es",
      status: "error",
      summary: "offline",
    });
  });
});
