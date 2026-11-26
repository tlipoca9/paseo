import { useEffect, useSyncExternalStore } from "react";
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

interface SharedSystemHealthStoreState {
  snapshot: DesktopSystemHealthSnapshot | null;
  cpuHistory: readonly number[];
}

const INITIAL_SHARED_STATE: SharedSystemHealthStoreState = Object.freeze({
  snapshot: null,
  cpuHistory: Object.freeze([]),
});

let sharedState: SharedSystemHealthStoreState = INITIAL_SHARED_STATE;
let lastPollAt = 0;
let activePollers = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let visibilityListenerAttached = false;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getHealthFetcher(): (() => Promise<DesktopSystemHealthSnapshot | null>) | null {
  const fn = getDesktopHost()?.system?.getHealth;
  return typeof fn === "function" ? fn : null;
}

function scheduleNextPoll(): void {
  if (activePollers <= 0 || pollTimer !== null) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void runSharedPoll();
  }, POLL_INTERVAL_MS);
}

async function runSharedPoll(): Promise<void> {
  if (activePollers <= 0 || pollInFlight) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    scheduleNextPoll();
    return;
  }

  const getHealth = getHealthFetcher();
  if (!getHealth) return;

  pollInFlight = true;
  try {
    const next = await getHealth();
    lastPollAt = Date.now();
    if (next) {
      const updatedHistory = [...sharedState.cpuHistory, next.cpu.percent];
      const trimmedHistory =
        updatedHistory.length > MAX_CPU_HISTORY
          ? updatedHistory.slice(updatedHistory.length - MAX_CPU_HISTORY)
          : updatedHistory;
      sharedState = {
        snapshot: next,
        cpuHistory: trimmedHistory,
      };
      emitChange();
    }
  } catch {
    // Keep last known snapshot on transient IPC failure.
  } finally {
    pollInFlight = false;
    scheduleNextPoll();
  }
}

function handleVisibilityChange(): void {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  if (activePollers <= 0) return;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  void runSharedPoll();
}

function retainSharedPoller(): () => void {
  activePollers += 1;
  if (activePollers === 1) {
    if (typeof document !== "undefined" && !visibilityListenerAttached) {
      document.addEventListener("visibilitychange", handleVisibilityChange);
      visibilityListenerAttached = true;
    }
    const elapsed = Date.now() - lastPollAt;
    if (sharedState.snapshot === null || elapsed >= POLL_INTERVAL_MS) {
      void runSharedPoll();
    } else {
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void runSharedPoll();
      }, POLL_INTERVAL_MS - elapsed);
    }
  }

  return () => {
    activePollers = Math.max(0, activePollers - 1);
    if (activePollers === 0) {
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (typeof document !== "undefined" && visibilityListenerAttached) {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        visibilityListenerAttached = false;
      }
    }
  };
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getStoreSnapshot(): SharedSystemHealthStoreState {
  return sharedState;
}

export function resetSharedSystemHealthForTest(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (typeof document !== "undefined" && visibilityListenerAttached) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    visibilityListenerAttached = false;
  }
  activePollers = 0;
  pollInFlight = false;
  lastPollAt = 0;
  sharedState = INITIAL_SHARED_STATE;
  listeners.clear();
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
  const isSupported = getHealthFetcher() !== null;
  const active = enabled && retainedPanelActive && isSupported;

  const state = useSyncExternalStore(subscribeStore, getStoreSnapshot, getStoreSnapshot);

  useEffect(() => {
    if (!active) return;
    return retainSharedPoller();
  }, [active]);

  return {
    snapshot: state.snapshot,
    cpuHistory: state.cpuHistory,
    isSupported,
  };
}
