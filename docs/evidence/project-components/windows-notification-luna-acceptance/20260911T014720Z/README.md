# Luna Windows notification acceptance attempt

This is the one-time Luna acceptance decision for installed Windows preview 20. It records a fail-closed environment blocker before business fixtures or product actions were started.

The installed preview root process was PID 22020 in Session 2, with CDP 9433 and desktop MCP 4642. The current-session audit retained 275 complete WPN `2418 -> 3052 -> 3153` chains, all targeting Session 1. The app and observer are in Session 2, so the required app/observer/WPN same-session gate is false. The native toast visible and click test therefore could not be safely operated in the current topology.

No toast was submitted, no native UI click was made, no project or API readback was claimed, no session was switched or restarted, and no production or daily client was touched. The prior runner proof and sanitized session audit are pinned by bytes and SHA-256 in `luna-acceptance-attempt.json`.

Validate from the repository root:

```powershell
node .\docs\evidence\project-components\windows-notification-luna-acceptance\20260911T014720Z\validate-evidence.mjs
```

Minimum retry conditions are recorded in the JSON. They require one unlocked interactive session containing the app, native submitter, and UIAutomation observer, plus correlated WPN `3052/3153` SessionId equality before any fixture is created.
