import { useCallback, useEffect, useState } from "react";
import { createUploadRequestId } from "./increment-upload-api";
import {
  getBuildCompatibility,
  refreshBuildCompatibility,
  type CompatibilityBatch,
} from "./packaging-api";
export function useBuildCompatibility(active: boolean, refreshRevision: number) {
  const [batch, setBatch] = useState<CompatibilityBatch | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const display = (value: CompatibilityBatch) => {
      if (controller.signal.aborted) return;
      setBatch(value);
      const done = value.checks.every((c) => c.state === "complete" || c.state === "error");
      setRefreshing(!done);
      if (!done) timer = setTimeout(() => void poll(value.id), 2000);
    };
    const fail = () => {
      if (!controller.signal.aborted) {
        setRefreshing(false);
        setError(true);
      }
    };
    const poll = async (id: string) => {
      try {
        display(await getBuildCompatibility(id, controller.signal));
      } catch {
        fail();
      }
    };
    const start = async () => {
      setBatch(null);
      setError(false);
      setRefreshing(true);
      try {
        display(await refreshBuildCompatibility(createUploadRequestId(), controller.signal));
      } catch {
        fail();
      }
    };
    void start();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, refreshRevision, revision]);
  return { batch, refreshing, error, refresh };
}
