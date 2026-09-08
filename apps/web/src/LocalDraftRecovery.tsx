import { useEffect, useState } from "react";
import type { AppDraft } from "./App";

function localFiles(value: unknown): File[] {
  if (value instanceof File) return [value];
  if (Array.isArray(value)) return value.flatMap(localFiles);
  if (value && typeof value === "object") return Object.values(value).flatMap(localFiles);
  return [];
}
export default function LocalDraftRecovery({
  draft,
  projectId,
}: {
  draft: AppDraft | undefined;
  projectId: string;
}) {
  const [files, setFiles] = useState<{ name: string; url: string }[]>([]);
  useEffect(() => {
    const items = [...new Set(localFiles(draft))].map((file) => ({
      name: file.name,
      url: URL.createObjectURL(file),
    }));
    setFiles(items);
    return () => items.forEach((file) => URL.revokeObjectURL(file.url));
  }, [draft]);
  const exportText = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { projectId, draft },
          (_key, value: unknown) =>
            value instanceof File
              ? { name: value.name, size: value.size, type: value.type }
              : value,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `qa-hub-local-draft-${projectId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="project-settings-summary">
      <h2>本地未提交内容</h2>
      <p>项目 {projectId} 的个人草稿仍保留在本机，恢复项目资格后可以继续处理。</p>
      {draft ? (
        <>
          <button className="secondary-button" onClick={exportText}>
            保存草稿文本
          </button>
          <div className="project-local-files">
            {files.map((file, index) => (
              <a key={`${file.name}:${index}`} href={file.url} download={file.name}>
                保存 {file.name}
              </a>
            ))}
          </div>
        </>
      ) : (
        <p>当前没有已保存的 Bug 草稿。</p>
      )}
    </section>
  );
}
