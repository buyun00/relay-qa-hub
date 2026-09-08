import { useCallback, useEffect, useRef, useState } from "react";
import { readProjectDraft, writeProjectDraft } from "./project-drafts";

export function useProjectFiles(key: string): [File[], (files: File[]) => void, string] {
  const [entries, setEntries] = useState<Record<string, File[]>>({});
  const [error, setError] = useState("");
  const changed = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    void readProjectDraft<File[]>(key)
      .then((files) => {
        if (active && !changed.current.has(key))
          setEntries((current) => ({ ...current, [key]: files ?? [] }));
      })
      .catch(() => {
        if (active) setError("附件本地存储不可用，请先保存自己的文件再关闭窗口。");
      });
    return () => {
      active = false;
    };
  }, [key]);
  const save = useCallback(
    (files: File[]) => {
      changed.current.add(key);
      setEntries((current) => ({ ...current, [key]: files }));
      void writeProjectDraft(key, files).catch(() =>
        setError("附件本地保存失败，请保留窗口并先保存自己的文件。"),
      );
    },
    [key],
  );
  return [entries[key] ?? [], save, error];
}
