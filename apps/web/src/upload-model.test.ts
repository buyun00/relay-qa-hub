import { describe, expect, it } from "vitest";
import type { UploadJob } from "../../desktop/src/uploader-types";
import {
  UPLOAD_MODES,
  uploadDraftDefaults,
  uploadJobLabel,
  uploadProgress,
  uploadStageLabel,
} from "./upload-model";

const job: UploadJob = {
  id: "fixture",
  createdAt: "",
  input: {
    productId: "2002",
    channelId: "1002",
    belongName: "fixture",
    version: "",
    summary: "fixture",
    description: "fixture",
    mode: "publish_workflow",
    testerId: 0,
    testResultReference: "",
  },
  active: true,
  stage: "UPLOADING",
  status: "running",
  errorCode: "",
  version: "",
  versionId: 0,
  sha256: "",
  size: 100,
  done: [],
  testResultLocked: false,
  pendingAction: "",
  published: false,
  publishTime: "",
  remoteStatus: 0,
  events: [
    {
      at: "",
      stage: "UPLOADING",
      kind: "progress",
      code: "",
      completedBytes: 100,
      totalBytes: 100,
      completedParts: 2,
      totalParts: 2,
    },
  ],
};
describe("upload progress and terminal states", () => {
  it("uses the recorded target and tester and keeps only two new-job endpoints", () => {
    expect(uploadDraftDefaults(null)).toMatchObject({
      productId: "2002",
      channelId: "1002",
      testerId: 11562,
      belongName: "[2002]Baloot Go|[1002]谷歌-国际正式",
      mode: "publish_workflow",
    });
    expect(UPLOAD_MODES.map((mode) => mode.id)).toEqual(["publish_workflow", "prepare_publish"]);
    expect(uploadDraftDefaults({ testerId: 1 }).testerId).toBe(11562);
    expect(uploadDraftDefaults({ testerId: 1, defaultsVersion: 2 }).testerId).toBe(1);
    expect(uploadDraftDefaults({ productId: 12, channelId: "", testerId: 0 })).toMatchObject({
      productId: "2002",
      channelId: "1002",
      testerId: 11562,
    });
  });
  it("retains custom targets, derives both text fields from version, migrates legacy drafts", () => {
    expect(
      uploadDraftDefaults({
        productId: "77",
        channelId: "88",
        testerId: 99,
        version: "2.4.28",
        summary: "old",
        description: "old",
        mode: "prepare_test",
        testResultReference: "old",
      }),
    ).toMatchObject({
      productId: "77",
      channelId: "88",
      testerId: 99,
      version: "2.4.28",
      summary: "2.4.28",
      description: "2.4.28",
      mode: "prepare_publish",
      testResultReference: "",
    });
    expect(
      uploadJobLabel({
        ...job,
        active: false,
        status: "awaiting_publish",
        stage: "AWAITING_PUBLISH_CONFIRMATION",
      }),
    ).toBe("等待最终确认发布");
  });
  it("100 percent uploaded does not mean published", () => {
    expect(uploadProgress(job)?.percent).toBe(100);
    expect(uploadJobLabel(job)).toBe("上传增量包");
    expect(uploadProgress({ ...job, stage: "WAIT_PUBLISHED" })).toBeNull();
    expect(uploadJobLabel({ ...job, stage: "WAIT_PUBLISHED" })).toBe("核验最终发布状态");
  });
  it("distinguishes test results, interrupted jobs and actual publication", () => {
    expect(uploadJobLabel({ ...job, active: false, status: "awaiting_test" })).toBe("等待测试结论");
    expect(uploadJobLabel({ ...job, active: false, status: "interrupted" })).toBe(
      "已中断 · 可恢复",
    );
    expect(
      uploadJobLabel({ ...job, active: false, status: "succeeded", stage: "TEST_REQUESTED" }),
    ).toBe("已提测 · 等待人工测试");
    expect(uploadJobLabel({ ...job, active: false, status: "succeeded", published: true })).toBe(
      "正式发布完成",
    );
  });
  it("unknown download length remains indeterminate and copy waits are visible", () => {
    const event = job.events[0];
    if (!event) throw new Error("Missing fixture event");
    expect(
      uploadProgress({
        ...job,
        stage: "DOWNLOADING",
        events: [{ ...event, kind: "downloadProgress", totalBytes: 0 }],
      })?.percent,
    ).toBeNull();
    expect(uploadStageLabel("WAIT_RELEASE_COPY")).toBe("等待正式资源复制");
  });
});
