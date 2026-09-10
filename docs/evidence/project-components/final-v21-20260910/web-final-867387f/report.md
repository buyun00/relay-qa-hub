# Web final targeted acceptance — commit 867387f

- Result: PASS
- Scope: dependency error only (`build_upload.single` while `build` and `upload.incremental` are disabled)
- Web: `http://127.0.0.1:4640/`
- API readback: `http://127.0.0.1:4639/api/v1/projects/3f6e5980-0ced-4030-b544-a8204e2a8be0/components`
- Source HEAD: `867387fe69714ae0c3aafa6182946ffd80495768`
- Isolated project: `Luna Final Dependency 0910` (`LFD0910`), project ID `3f6e5980-0ced-4030-b544-a8204e2a8be0`

The visible Web UI created the isolated project with the status `项目已创建，仅启用 Bug 管理。`. In GM project management, all five components initially displayed `未启用`. I entered `dependency-test` in the `打包预设键` field for `单次打包上传`, checked `为此项目启用`, and selected `保存组件`.

The UI visibly displayed the exact dependency error:

`请先启用打包和增量上传，再启用单次打包上传；当前输入仍保留。`

After the 409, the `单次打包上传` switch remained checked and the input still displayed `dependency-test`. No `记录已变化` text was present. The HTTP readback confirmed `build=false/disabled`, `upload.incremental=false/disabled`, and `build_upload.single=false/disabled`, all at version `0`; the failed enable did not alter server state.

Browser and asset details are in `browser-ui.json` and `asset-sha256.json`; the sanitized HTTP readback is in `http-component-readback.json`.
