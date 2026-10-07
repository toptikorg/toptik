"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MediaSyncMonitorView from "./MediaSyncMonitorView";
import { applyMonitorResult, initialMonitorState, loadMediaSyncMonitor, startMonitorRequest, MEDIA_MONITOR_STALE_MS, type MonitorState } from "@/lib/shopify/media-sync-monitor";

/** Loads once on open and on an explicit refresh only: no polling, no writes. */
export default function MediaSyncMonitor() {
  const [state, setState] = useState<MonitorState>(initialMonitorState);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state), controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    const started = startMonitorRequest(stateRef.current);
    stateRef.current = started.state; setState(started.state); setLoading(true);
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 15000);
    const result = await loadMediaSyncMonitor(fetch, abort.signal);
    clearTimeout(timer);
    const next = applyMonitorResult(stateRef.current, started.seq, result);
    if (next !== stateRef.current) { stateRef.current = next; setState(next); }
    if (started.seq === stateRef.current.latestSeq) { setLoading(false); setNow(Date.now()); }
  }, []);
  useEffect(() => { void load(); return () => controller.current?.abort(); }, [load]);
  // Expire the displayed evidence locally, without polling the server. A hidden
  // tab may suspend timers, so returning to it also updates the clock immediately.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      const current = Date.now();
      const deadlines = state.payload ? [state.payload.queues, state.payload.reasons, state.payload.items]
        .filter(section => section.available)
        .map(section => section.available ? Date.parse(section.observedAt) + MEDIA_MONITOR_STALE_MS + 1 : NaN)
        .filter(deadline => Number.isFinite(deadline) && deadline > current) : [];
      if (deadlines.length) timer = setTimeout(tick, Math.min(...deadlines) - current);
    };
    const tick = () => { setNow(Date.now()); schedule(); };
    const visible = () => { if (document.visibilityState === "visible") tick(); };
    schedule();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", tick);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pageshow", tick);
    };
  }, [state.payload]);
  return <MediaSyncMonitorView payload={state.payload} failure={state.failure} loading={loading} now={now} onRefresh={() => { void load(); }} />;
}
