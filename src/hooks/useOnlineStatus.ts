import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// Real connectivity detection.
//
// `navigator.onLine` is useless for this in Electron: it only reflects whether
// an OS network interface is up (e.g. "connected to the shop WiFi/router") and
// the online/offline DOM events rarely fire on actual internet loss. That kept
// the app stuck in "online" mode — and every offline branch dead — whenever the
// internet dropped but the router stayed up.
//
// So we probe the Supabase REST endpoint on a timer. Any HTTP response (even a
// 401 or 404) proves the server is reachable; only timeouts / network errors
// count as offline. A short debounce prevents flapping on a single hiccup.
//
// The probe loop is shared module-wide (a singleton), so every page/hook that
// pulls useOnlineStatus consumes the same state instead of starting its own
// timer (the app had 80+ consumers).

const SUPABASE_URL = (supabase as unknown as { supabaseUrl: string }).supabaseUrl;
const PROBE_URL = `${SUPABASE_URL}/rest/v1/`;
const PROBE_INTERVAL_MS_ONLINE = 30_000;
const PROBE_INTERVAL_MS_OFFLINE = 10_000;
const PROBE_TIMEOUT_MS = 6_000;
const OFFLINE_THRESHOLD = 2; // consecutive failed probes before declaring offline

let onlineState = navigator.onLine;
let probeFailures = 0;
let probeTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;
const listeners = new Set<(online: boolean) => void>();

const setOnline = (online: boolean) => {
  if (onlineState === online) return;
  onlineState = online;
  listeners.forEach((listener) => listener(online));
};

const probeOnce = async (): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(SUPABASE_URL && PROBE_URL ? PROBE_URL : SUPABASE_URL, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    // Any HTTP response means the server is reachable — online.
    return typeof response?.status === "number" && response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

const runProbe = async () => {
  // Pause while the tab is backgrounded — saves egress/log ingestion on idle tills.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const reachable = await probeOnce();
  if (reachable) {
    probeFailures = 0;
    setOnline(true);
  } else {
    probeFailures += 1;
    if (probeFailures >= OFFLINE_THRESHOLD) {
      setOnline(false);
    }
  }
};

// Dynamic cadence: slower while online (30s), faster while offline (10s) so we
// recover quickly but don't spam the gateway when everything is fine.
const scheduleNext = () => {
  if (probeTimer) clearTimeout(probeTimer);
  const delay = onlineState ? PROBE_INTERVAL_MS_ONLINE : PROBE_INTERVAL_MS_OFFLINE;
  probeTimer = setTimeout(async () => {
    await runProbe();
    if (subscriberCount > 0) scheduleNext();
  }, delay);
};

const ensureProbeLoop = () => {
  if (probeTimer) return;
  // Probe immediately on start, then keep probing on a dynamic cadence.
  void runProbe();
  scheduleNext();
};

const stopProbeLoopIfIdle = () => {
  if (probeTimer && subscriberCount <= 0) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
};

/** One-shot reachability check. Used on boot before deciding whether a
 *  persisted offline login may be restored (see useAuth). */
export const checkSupabaseReachable = probeOnce;

export const useOnlineStatus = () => {
  const [isOnline, setIsOnline] = useState(onlineState);

  useEffect(() => {
    subscriberCount += 1;
    ensureProbeLoop();

    const update = (online: boolean) => setIsOnline(online);
    listeners.add(update);

    // Browser fast-path: if Chromium *does* fire offline, trust it immediately.
    // The online event is only a hint — we still confirm with a probe so the
    // app doesn't flip back to "online" on a router-only link.
    const handleOffline = () => {
      probeFailures = OFFLINE_THRESHOLD;
      setOnline(false);
      update(false);
    };
    const handleOnline = () => {
      void runProbe();
      scheduleNext();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void runProbe();
        scheduleNext();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      listeners.delete(update);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisibility);
      subscriberCount -= 1;
      stopProbeLoopIfIdle();
    };
  }, []);

  return { isOnline };
};