import { useCallback, useEffect, useRef, useState } from "react";
import { createUploadRequestId } from "./increment-upload-api";
import {
  getBuildCompatibility,
  refreshBuildCompatibility,
  type CompatibilityBatch,
} from "./packaging-api";

export function useBuildCompatibility(active: boolean) {
  const [batch, setBatch] = useState<CompatibilityBatch | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const busy = useRef(false);
  const previousActive = useRef(active);
  const entryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refresh = useCallback(() => {
    clearTimeout(entryTimer.current);
    if (busy.current) return;
    busy.current = true;
    setRefreshing(true);
    setError(false);
    setBatch(null);
    setRequestId(createUploadRequestId());
  }, []);

  // Navigation is different from mounting or refreshing page data.
  useEffect(() => {
    const entered = active && !previousActive.current;
    previousActive.current = active;
    if (entered) entryTimer.current = setTimeout(refresh, 2000);
    return () => clearTimeout(entryTimer.current);
  }, [active, refresh]);

  useEffect(() => {
    if (!requestId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      if (controller.signal.aborted) return;
      busy.current = false;
      setRefreshing(false);
      setError(true);
    };
    const display = (value: CompatibilityBatch) => {
      if (controller.signal.aborted) return;
      setBatch(value);
      const done = value.checks.every((c) => c.state === "complete" || c.state === "error");
      busy.current = !done;
      setRefreshing(!done);
      if (!done) timer = setTimeout(() => void poll(value.id), 2000);
    };
    const poll = async (id: string) => {
      try {
        display(await getBuildCompatibility(id, controller.signal));
      } catch {
        fail();
      }
    };
    void refreshBuildCompatibility(requestId, controller.signal).then(display, fail);
    // Observe the same server-owned batch even while another tab is selected.
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [requestId]);
  return { batch, refreshing, error, refresh };
}
