import { useEffect, useRef, useState } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  getDesktopHost,
  type DesktopSystemHealthSnapshot,
  type DesktopSystemServiceNode,
  type DesktopSystemServiceStatus,
} from "@/desktop/host";

const POLL_INTERVAL_MS = 6_000;
const MAX_CPU_HISTORY = 16;

export interface SystemHealthState {
  snapshot: DesktopSystemHealthSnapshot | null;
  cpuHistory: readonly number[];
  isSupported: boolean;
}

export function getWorstServiceStatus(
  nodes: readonly DesktopSystemServiceNode[],
): DesktopSystemServiceStatus {
  let worst: DesktopSystemServiceStatus = "ok";
  const rank: Record<DesktopSystemServiceStatus, number> = {
    ok: 0,
    unknown: 1,
    warn: 2,
    error: 3,
  };

  const visit = (list: readonly DesktopSystemServiceNode[]) => {
    for (const node of list) {
      if (rank[node.status] > rank[worst]) {
        worst = node.status;
      }
      if (node.children?.length) {
        visit(node.children);
      }
    }
  };

  visit(nodes);
  return worst;
}

export function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0G";
  const gib = bytes / 1024 ** 3;
  if (gib >= 100) return `${Math.round(gib)}G`;
  if (gib >= 10) return `${gib.toFixed(1)}G`;
  return `${gib.toFixed(1)}G`;
}

export function useSystemHealth(enabled: boolean): SystemHealthState {
  const retainedPanelActive = useRetainedPanelActive();
  const [snapshot, setSnapshot] = useState<DesktopSystemHealthSnapshot | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const mountedRef = useRef(true);

  const getHealth = getDesktopHost()?.system?.getHealth;
  const isSupported = typeof getHealth === "function";
  const active = enabled && retainedPanelActive && isSupported;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || !getHealth) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        timerId = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }

      try {
        const next = await getHealth();
        if (!cancelled && mountedRef.current && next) {
          setSnapshot(next);
          setCpuHistory((prev) => {
            const updated = [...prev, next.cpu.percent];
            return updated.length > MAX_CPU_HISTORY
              ? updated.slice(updated.length - MAX_CPU_HISTORY)
              : updated;
          });
        }
      } catch {
        // Keep last known snapshot on transient IPC failure.
      } finally {
        if (!cancelled) {
          timerId = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    };

    void poll();

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
        void poll();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [active, getHealth]);

  return { snapshot, cpuHistory, isSupported };
}
