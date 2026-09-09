# Sol Goal 接续时的 worktree 元数据恢复

2026-09-09 接续交接时，指定源码目录仍完整存在，但根目录 `.git` gitfile 和 `D:\Relay-QA-Hub\.git\worktrees` 中对应的管理项均已缺失，普通 Git 命令因此返回“not a git repository”。共享仓库内的 `refs/heads/codex/project-components-v2-1` 仍准确指向交接 HEAD `5208a8aef2c777ad8f3bf8d3fe0fccb2120881c1`，提交历史和 reflog 完整。

恢复只重建 linked-worktree 管理目录、gitfile 和 index，并将该 worktree 标记为 active locked。index 由当时 HEAD 的树读取，没有写入源码。原 index 管理文件已经不存在，因此先前的 staged 位信息本身无法读取；交接明确列出的 Phase D 24 个文件按实际内容重新核对、精确暂存并提交为 `4eece8e`，没有把 C/E 候选或其他未提交源码混入。

同时观察到 7 个由 HEAD 跟踪的点文件缺失，且不在交接所列产品改动范围。恢复前逐项确认路径确实不存在，再用 `git checkout-index` 仅写入这些缺失路径；没有覆盖任何现有文件。恢复后的 Git blob ID 全部与 `5208a8a` 树一致。精确路径、对象 ID、动作边界与当前 worktree 注册结果见 `before.json` 和 `result.json`。

本操作没有执行 reset、clean、stash、rebase，没有修改 `D:\Relay-QA-Hub` 生产工作区文件，也没有启停服务或客户端。产品源码候选、证据、runtime、数据库、附件、队列、WAL 和历史失败均保留。
