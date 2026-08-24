# ADR-0007: App-first Android client and thin Poco QA Bridge

- Status: Accepted
- Date: 2026-08-24
- Supersedes: the unstarted P3 Web/PWA client plan; it does not rewrite P0.1-P0.4 history

## Context

After G0 was completed, the product owner made Android native the primary human
client. QA work happens beside the tested Unity application and needs reliable
offline queues, explicit system capture, a floating entry point, system sharing,
and access to the Poco runtime already present in internal test builds. A PWA or
WebView cannot be the mobile MVP without weakening these platform and evidence
requirements. The host does not yet have Android Studio, an SDK, adb, or Java,
so source scaffolding must not be represented as a built or tested APK.

Poco is useful enrichment but its upstream Unity server binds all interfaces by
default, exposes unauthenticated operational RPCs, and has version ambiguity
around Invoke extensions. It therefore cannot be treated as a trusted workflow
service or as a replacement for the QA Hub API.

## Decision

The native Kotlin/Jetpack Compose Android App is the only primary human client
for `0.1.0-debug`. It implements all QA workflows, Room-scoped cache/drafts and
queues, WorkManager retry, MediaProjection/overlay/share capture, notifications,
and Relay handoff/receipt presentation. The independent QA Hub API/database
remains the sole business source of truth, and Relay remains an optional repair
executor. Existing `apps/web` history is preserved but deferred to a post-MVP
desktop management/read-only diagnostic role; no further PWA installation,
Service Worker, or browser offline-capture work belongs to the MVP.

Android support starts at API 31, with compile/target API 36, checked-in Gradle
Wrapper, Android Studio bundled JDK, and no NDK/CMake/native C++ dependency.
Emulators use WHPX without disabling Hyper-V. Missing toolchain components are
an explicit build-verification blocker, while contracts, backend work, and
read-only Poco capability discovery continue.

The Poco QA Bridge is deliberately thin. The App implements only a bounded,
cancellable, read-only SimpleRPC client and treats MediaProjection as the main
evidence. The Unity QA/Debug build must bind Poco to Loopback and register only
the required read-only standard methods plus a `qa.snapshot` Invoke listener.
The optional provider is a small compatibility seam based on the actual vendored
Poco capability; it is not a general Reporter SDK and contains no app-side
hardcoded game business state. Poco absence, timeout, old versions, or oversized
responses degrade enrichment without blocking a normal screenshot defect.

## Consequences

G3 becomes `G3-ANDROID-APP-READY` and joins the core path between backend/API and
the human/Relay flows. A real APK/AAB, Android 12/13/14/15/16 evidence, Room and
WorkManager failure recovery, explicit capture lifecycle, and Poco loopback/LAN
negative tests are required. Android 12L is a non-blocking compatibility probe;
MuMu supplements but cannot replace Android 12 real-device evidence, and its API
level must be read through adb.

The server contracts need an additive App-first revision for native workflow,
attachment finalize/bind, stable item IDs, capture bundles, and enrichment
status before Android business code begins. P0.3 `1.0.0` and all G0 commits stay
immutable historical evidence. Web code remains in the repository and continues
to build as a preserved asset until the deferred desktop plan is intentionally
resumed.

Poco security may block debug readiness even when capture works: App-side method
allowlisting alone cannot protect against a malicious same-device client. The
Unity server must also remove operational RPC registrations and prove that LAN
connections fail. Standard Poco artifacts are time-correlated by capture ID and
per-artifact timestamps, not claimed to be an atomic same-frame snapshot.

## Rejected alternatives

Keeping PWA as the mobile MVP was rejected because it does not provide the
required native overlay, capture lifecycle, durable app queue, and thin local
Poco integration. Wrapping the Web UI in a WebView was rejected because the
product owner requires a native App home and native on-device flow. Treating
Poco as the source of truth or enabling its full control RPC surface was rejected
because it is unauthenticated, operationally powerful, and coupled to a test
build. Building a full Unity Reporter SDK was rejected in favor of standard Poco
fallback plus one versioned, read-only `qa.snapshot` compatibility seam.
