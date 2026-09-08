import { projectStorageKey } from "./project-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { getPackagingProgress, type PackagingProgress } from "./packaging-api";
import { readWatchedBuilds, reconcileBuilds, type WatchedBuild } from "./packaging-monitor";
import { notifyPackagingSystem } from "./packaging-notifications";

export function usePackagingProgress(
  userId: string,
  active: boolean,
  refreshRevision: number,
  onCompleted: () => void,
  onOpen?: () => void,
) {
  const storageKey = projectStorageKey("packaging-watch", undefined, userId);
  const [initialWatched] = useState<WatchedBuild[]>(() => {
    try {
      return readWatchedBuilds(
        typeof localStorage === "undefined" ? null : localStorage.getItem(storageKey),
      );
    } catch {
      return [];
    }
  });
  const watched = useRef(initialWatched);
  const [progress, setProgress] = useState<PackagingProgress | null>(null);
  const [error, setError] = useState(false);
  const openPackaging = useRef(onOpen);
  useEffect(() => {
    openPackaging.current = onOpen;
  }, [onOpen]);
  const [revision, setRevision] = useState(0);
  const persist = useCallback(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(watched.current));
    } catch {
      /* Tracking continues in memory when storage is unavailable. */
    }
  }, [storageKey]);
  const watch = useCallback(
    (queueId: number) => {
      const values = watched.current;
      if (!values.some((entry) => entry.queueId === queueId)) {
        watched.current = [
          ...values,
          { queueId, submittedAt: Date.now(), finished: false, alerts: [] },
        ].slice(-10);
        persist();
      }
      setRevision((v) => v + 1);
    },
    [persist],
  );

  useEffect(() => {
    if (!active && !watched.current.some((w) => !w.finished)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const tracking = watched.current.filter((w) => !w.finished);
      try {
        const snapshot = await getPackagingProgress(
          tracking.map((w) => w.queueId),
          tracking.flatMap((w) => (w.number ? [w.number] : [])),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        // Opening this page also follows builds already running in Jenkins.
        if (active) {
          for (const build of snapshot.builds) {
            if (
              build.status !== "BUILDING" ||
              build.queueId === null ||
              watched.current.some((w) => w.queueId === build.queueId)
            )
              continue;
            watched.current = [
              ...watched.current,
              {
                queueId: build.queueId,
                number: build.number,
                submittedAt: Date.now(),
                finished: false,
                alerts: [],
              },
            ].slice(-10);
          }
        }
        const result = reconcileBuilds(watched.current, snapshot);
        watched.current = result.watched;
        persist();
        setProgress(snapshot);
        setError(false);
        if (result.notices.length) {
          for (const notice of result.notices)
            void notifyPackagingSystem(notice, () => openPackaging.current?.()).catch(
              () => undefined,
            );
        }
        if (result.completed) onCompleted();
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
      if (!controller.signal.aborted && (active || watched.current.some((w) => !w.finished)))
        timer = setTimeout(() => void poll(), 5_000);
    };
    void poll();
    // Continue polling when this page or the application window is in the background.
    const resume = () => {
      if (document.visibilityState === "visible") setRevision((v) => v + 1);
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [active, refreshRevision, revision, onCompleted, persist]);
  return {
    progress,
    error,
    watch,
    pendingQueues: watched.current
      .filter((w) => !w.finished && w.number === undefined)
      .map((w) => w.queueId),
  };
}
