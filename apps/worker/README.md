# `@relay-qa-hub/worker`

The worker is an independent process with an immediate polling loop. Every poll
receives an `AbortSignal`; `SIGINT`, `SIGTERM`, and a caller-provided signal all
flow through the same graceful shutdown path.

The P0 poll handler is intentionally local and empty. Startup and readiness do
not contact Relay, so Relay being offline cannot prevent the worker from
running. Later outbox, inbox, notification, and duplicate-candidate processors
can be added as signal-aware poll handlers without changing the lifecycle
boundary.
