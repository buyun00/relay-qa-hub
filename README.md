# Relay QA Hub

Relay QA Hub is an independent, mobile-first defect closed-loop product. QA Hub is the business source of truth; Relay is an optional repair executor and can never accept or close a QA bug automatically.

The authoritative implementation plan is [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). Execution status and verification evidence live only in [`PROGRESS.md`](PROGRESS.md).

## Isolation boundary

- Source: `D:\Relay-QA-Hub`
- Persistent runtime data: `D:\Relay-QA-Hub-Data` (configurable and outside the repository)
- Relay source/runtime/data: separate and never imported, shared, or used as the QA Hub database or attachment store
- Qingyu: no runtime, data, authentication, state, or synchronization dependency

Runtime binaries and reproducible local commands are recorded in [`docs/RUNTIME_PATHS.md`](docs/RUNTIME_PATHS.md).
