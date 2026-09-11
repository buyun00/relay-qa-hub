import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listGmProjects = vi.hoisted(() => vi.fn());
const listProjectComponents = vi.hoisted(() => vi.fn());
const listManagedProjectUsers = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  QaHubApiError: class QaHubApiError extends Error {},
  listManagedProjectUsers,
}));
vi.mock("./project-api", () => ({
  componentLabels: {},
  listGmProjects,
  listProjectComponents,
  resetProjectJoinCode: vi.fn(),
  revokeInitializationLink: vi.fn(),
  rotateInitializationLink: vi.fn(),
  saveComponent: vi.fn(),
  saveMembership: vi.fn(),
  saveProject: vi.fn(),
  updateProject: vi.fn(),
}));

import ProjectManagementPage from "./ProjectManagementPage";

const PROJECT = {
  id: "30000000-0000-4000-8000-000000000001",
  key: "P0000001",
  name: "待初始化 P0000001",
  active: true,
  version: 1,
  initializationStatus: "pending" as const,
  joinCode: "0042",
  joinCodeVersion: 1,
  initializationTokenStatus: "issued" as const,
  initializationLink: "http://qa.local/#initialize=token",
};

describe("ProjectManagementPage onboarding controls", () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    listGmProjects.mockResolvedValue([PROJECT]);
    listProjectComponents.mockResolvedValue({ projectId: PROJECT.id, items: [] });
    listManagedProjectUsers.mockResolvedValue({ projectId: PROJECT.id, items: [] });
  });

  it("shows status, code, initialization link and GM rotation actions", async () => {
    await act(async () => {
      renderer = create(<ProjectManagementPage projectId="" onSelectProject={vi.fn()} />);
    });
    if (renderer === undefined) throw new Error("renderer did not mount");
    const picker = renderer.root.findByProps({ className: "project-settings-picker" });
    const select = picker.findByType("select");
    await act(async () => {
      select.props.onChange({ target: { value: PROJECT.id } });
    });
    const summaryText = JSON.stringify(renderer.toJSON());
    expect(summaryText).toContain("0042");
    expect(summaryText).toContain("#initialize=token");
    const buttons = renderer.root.findAllByType("button").map((button) => button.children.join(""));
    expect(buttons).toEqual(
      expect.arrayContaining(["复制初始化链接", "重置四位码", "重签初始化链接", "撤销初始化链接"]),
    );
    renderer.unmount();
  });
});
