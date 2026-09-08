# GM 真实浏览管理验收

记录时点：2026-09-08T18:02:40.450Z。浏览器 4274 → 独立 API 4419 / schema 14。项目 fb81f6b5-43ed-4e8f-b848-502c0dcf9848，短码 GB1788890272232。

- **gm_login_create: passed** — Actual management password login and UI create; uppercase 15-character shortcode accepted; all five components default off. 证据：gm-01-created.json、gm-01-created.jpg。
- **component_toggle_configuration: passed** — Enable empty build -> needs_configuration; disable, save loopback dummy target/job/presets and refresh; private form retains values at version2. No task execution requested. 证据：gm-02-needs-configuration.json、gm-03-config-refreshed.json、gm-http-readback.json。
- **membership_manage: passed** — Add existing employee, disable, restore through real UI; readback active membership version3. 证据：gm-04-member-disabled.json、gm-04-member-disabled.jpg、gm-http-readback.json。
- **project_disable_restore: passed** — Initial successful disable falsely displayed PROJECT_NOT_ACCESSIBLE due follow-up active-project queries. Fixed Web refresh to skip inactive business reads; fresh bundle disable/restore shows success, disables enter, preserves configuration and memberships; readback active version5. 证据：gm-05-project-disabled-before-fix.json、gm-06-project-disabled-fixed.json、gm-06-project-disabled-fixed.jpg、gm-07-project-restored.json、gm-http-readback.json。
- **shortcode_login: passed** — Logged out GM; lowercase shortcode and existing employee name entered correct stable UUID project. Selector retained three actual memberships. 证据：gm-08-shortcode-login.json、gm-08-shortcode-login.jpg。
- **disabled_history: passed** — All five disabled; actual component-history navigation rendered empty build/upload/chain/Relay/Qingyu local histories without error. 证据：gm-09-disabled-history.json、gm-09-disabled-history.jpg、gm-http-readback.json。

服务端读回 5/5：项目 active / v5，成员 active / v3，build disabled / v2、配置保留，五组件均关闭、0 构建任务。

停用误报修复后加载 index-WAJtVpCO.js 再测，旧错误证据保留。口令与 token 未进入输出或证据。

- No external build/upload/Relay/Qingyu execution; external full chains remain not_run.
- GM nonmember full manual lifecycle is proven by persistent HTTP management smoke, not repeated in browser.
- UI rename prompt, stale-version conflict, every component field and every history action were not exercised by this run.
- Credential was read only inside tool process for the explicitly authorized local login; password/token not emitted or included in artifacts.
