import { describe, expect, it } from "vitest";
import { normalizeProductionBatches } from "./ProductionPage";

describe("production page batch compatibility", () => {
  const item = {
    input: { title: "修复白屏" },
    status: "accepted",
    result: { taskId: "task-1" },
  };

  it("keeps the current production batch response contract", () => {
    expect(
      normalizeProductionBatches({
        items: [
          {
            id: "batch-1",
            kind: "create",
            status: "completed",
            createdAt: "2026-09-11T10:00:00.000Z",
            updatedAt: "2026-09-11T10:01:00.000Z",
            items: [item],
          },
        ],
      }),
    ).toEqual([
      {
        id: "batch-1",
        kind: "create",
        status: "completed",
        createdAt: "2026-09-11T10:00:00.000Z",
        updatedAt: "2026-09-11T10:01:00.000Z",
        items: [item],
      },
    ]);
  });

  it("normalizes imported component-history batches instead of blanking the page", () => {
    expect(
      normalizeProductionBatches({
        items: [
          {
            id: "batch-legacy",
            status: "completed",
            createdAt: "2026-09-11T09:00:00.000Z",
            updatedAt: "2026-09-11T09:01:00.000Z",
            result: { kind: "bugs", items: [item] },
          },
        ],
      }),
    ).toEqual([
      {
        id: "batch-legacy",
        kind: "bugs",
        status: "completed",
        createdAt: "2026-09-11T09:00:00.000Z",
        updatedAt: "2026-09-11T09:01:00.000Z",
        items: [item],
      },
    ]);
    expect(normalizeProductionBatches({ items: [{ id: "broken" }] })).toEqual([]);
  });
});
