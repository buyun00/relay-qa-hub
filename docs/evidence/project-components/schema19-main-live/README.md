# Final preview core acceptance runner

`schema19-main-live.mjs` keeps its historical filename so earlier retained proof folders remain traceable. The current runner accepts only `qa-hub-preview-final-sol-0909` and requires schema **20** through the single `expectedSchemaVersion` constant.

Running it performs isolated preview writes for the core project, login, Bug, attachment, comment, human-repair, Verification, close, rejection, pagination, HTTP, server MCP, and SQLite paths, then best-effort logs out every session it created. A logout failure is retained as an explicit failed cleanup without recording a token.

The preview manager's process receipt has stable instance, service, PID, creation-time, executable, and command-line fields, which the runner checks against the live API and server MCP processes. That receipt has no source HEAD or build hash, so `runtimeBuildBinding` explicitly leaves the running `apps/api/dist/main.js`-to-source/build attribution for the main flow to verify separately. The runner must not be cited as that binding proof.

Running it does not prove Web UI, installed EXE/local MCP, APK/MuMu, a physical Android device, migration rollback, or any enabled external component; those remain separate mandatory acceptance runs. Invoking the file without `--run` is inert and prints this scope as `not_run`.
