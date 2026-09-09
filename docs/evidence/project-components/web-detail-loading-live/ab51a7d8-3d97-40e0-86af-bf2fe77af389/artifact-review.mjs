import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// Artifact-only audit. No HTTP, browser, process, device or profile access.
const runId = "ab51a7d8-3d97-40e0-86af-bf2fe77af389";
const sourceRoot = "C:/Users/lin0/.codex/worktrees/7c86/Relay-QA-Hub";
const publicRoot = join(
  sourceRoot,
  "docs/evidence/project-components/web-detail-loading-live",
  runId,
);
const runtime =
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/web-detail-loading-" + runId;
const originalNames = [
  "proof.json",
  "runner.mjs.txt",
  "01-real-response-held-loading.png",
  "02-first-real-detail-loaded.png",
  "03-actual-network-catch-error.png",
  "04-actual-retry-real-200.png",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (path) => resolve(path).toLowerCase();
function exactFile(path, root) {
  assert.equal(canonical(dirname(path)), canonical(root), "EXACT_FILE_PARENT_REFUSED");
  assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "REGULAR_FILE_REQUIRED");
  assert.equal(canonical(realpathSync(path)), canonical(path), "FILE_LINK_REFUSED");
  return readFileSync(path);
}
function inspect(path, root) {
  const bytes = exactFile(path, root);
  return { path, bytes: bytes.length, sha256: sha(bytes) };
}
function run() {
  const checks = [];
  const check = (label, passed) => checks.push({ label, passed: Boolean(passed) });
  const originalBefore = originalNames.map((name) => inspect(join(publicRoot, name), publicRoot));
  const proofBytes = exactFile(join(publicRoot, "proof.json"), publicRoot);
  const p = JSON.parse(proofBytes.toString("utf8"));
  check("run status and exact identity", p.status === "passed" && p.runId === runId);
  assert.equal(canonical(p.runtime), canonical(runtime), "EXACT_PRIVATE_RUNTIME_REFUSED");
  check(
    "profile is only referenced, within this new run",
    canonical(p.profile) === canonical(join(runtime, "edge-profile")),
  );
  check(
    "all 59 declared checks independently compare equal",
    p.checks.length === 59 &&
      p.checks.every((x) => x.passed === true && isDeepStrictEqual(x.expected, x.actual)),
  );
  check(
    "private/public proof bytes identical",
    sha(exactFile(join(runtime, "proof.json"), runtime)) === sha(proofBytes),
  );
  const expectedSourceSha = "29aec997bfacc12f646254dd7aad7f9794200446686b33d27b0efcf1c5bd07ae";
  const runnerBytes = exactFile(join(publicRoot, "runner.mjs.txt"), publicRoot);
  check(
    "run source matches frozen source",
    sha(runnerBytes) === expectedSourceSha && p.sourceSha256 === expectedSourceSha,
  );
  check(
    "private runner matches frozen source",
    sha(exactFile(join(runtime, "runner.mjs"), runtime)) === expectedSourceSha,
  );
  check(
    "current runner remains unchanged",
    sha(
      exactFile(
        join(sourceRoot, "scripts/project-components/web-detail-loading-live.mjs"),
        join(sourceRoot, "scripts/project-components"),
      ),
    ) === expectedSourceSha,
  );
  const runnerText = runnerBytes.toString("utf8");
  check(
    "frozen source uses original-response continuation, no fabricated success API",
    runnerText.includes('this.call("Fetch.continueRequest", { requestId })') &&
      !runnerText.includes("Fetch.fulfillRequest"),
  );
  check(
    "frozen source uses normal Browser.close and no process kill",
    runnerText.includes('browser.call("Browser.close")') &&
      !/\b(?:execFileSync|spawn)\([^\n]*(?:taskkill|Stop-Process)/u.test(runnerText) &&
      !/child\.kill\(/u.test(runnerText),
  );

  const gateRoot =
    "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/acceptance/web-detail-fix-publication-e2d5cb4b-9068-4f14-9f90-d292ee4af864";
  const gateRef = inspect(join(gateRoot, "browser-gate.json"), gateRoot);
  check(
    "exact gate SHA",
    gateRef.sha256 === "93cf0483a13b02ab8ed31f3799e61f69f2c76368ec51280a6c1388f48159c56c" &&
      p.gate.gateSha256 === gateRef.sha256 &&
      canonical(p.gate.gatePath) === canonical(gateRef.path),
  );
  const publicationRoot = join(
    sourceRoot,
    "docs/evidence/project-components/web-detail-fix-publication/e2d5cb4b-9068-4f14-9f90-d292ee4af864",
  );
  const publicationRef = inspect(join(publicationRoot, "deploy.json"), publicationRoot);
  check(
    "exact publication SHA",
    publicationRef.sha256 === "0ec3abdbdbe85e1d3ab79155a8dcc2f31c21e999e634834ddb488000e90cff63" &&
      publicationRef.sha256 === p.gate.publicationProof.sha256,
  );
  const publication = JSON.parse(exactFile(publicationRef.path, publicationRoot));
  check("publication was published_verified", publication.status === "published_verified");
  const postScopeRef = inspect(join(publicationRoot, "post-scope.json"), publicationRoot);
  check("referenced publication post-scope SHA", postScopeRef.sha256 === p.gate.postScope.sha256);
  const assetChecks = p.checks.filter((x) => x.label.startsWith("published asset SHA "));
  check(
    "eight current asset checks match pinned publication file manifest",
    assetChecks.length === 8 &&
      assetChecks.every((x) => {
        const path = x.label.slice("published asset SHA ".length);
        const file = publication.servedAfter.files.find((item) => item.path === path);
        const size = p.checks.find((item) => item.label === "published asset bytes " + path);
        return file && file.sha256 === x.actual && size?.actual === file.bytes;
      }),
  );
  check(
    "actual browser bundle SHA and size",
    p.bundles.length === 1 &&
      p.bundles[0].status === 200 &&
      p.bundles[0].sizeBytes === 477433 &&
      p.bundles[0].sha256 === "813277e9792c91d27b2e153322a0a2bfcad277ec57723df712f7d84ae24ad3ae" &&
      p.bundles[0].url === "http://127.0.0.1:4274/assets/index-Br-CEXQI.js",
  );

  const rawRows = p.requests.filter((x) => x.rawPath);
  check(
    "24 distinct non-authentication raw files",
    rawRows.length === 24 && new Set(rawRows.map((x) => x.rawPath)).size === 24,
  );
  const bodies = new Map(),
    rawReferences = [];
  for (const item of rawRows) {
    assert(
      !String(item.path).startsWith("/api/v1/auth/") && item.category !== "login",
      "AUTH_BODY_READ_REFUSED",
    );
    assert(
      /^\d{3}-(?:ready|fresh-project|five-off|one-bug|initial-detail|initial-events|browser-(?:components|bugs|detail|events|attachments|detail-read)|final-(?:detail|events|list|comments|attachments|five-off))\.body$/u.test(
        basename(item.rawPath),
      ),
      "RAW_FILE_NAME_REFUSED",
    );
    const bytes = exactFile(item.rawPath, join(runtime, "raw"));
    const ref = { path: item.rawPath, bytes: bytes.length, sha256: sha(bytes) };
    rawReferences.push(ref);
    check(
      "raw bytes/hash " + basename(item.rawPath),
      ref.bytes === item.bytes && ref.sha256 === item.sha256,
    );
    bodies.set(item, JSON.parse(bytes.toString("utf8")));
  }
  const labeled = (label) => bodies.get(p.requests.find((x) => x.label === label));
  const direct = p.requests.filter((x) => x.kind === "fixture_api");
  const browserRequests = p.requests.filter((x) => x.kind === "browser_request");
  const responses = p.requests.filter((x) => x.kind === "browser_real_response");
  check(
    "ledger contains 14 direct calls, 24 browser requests and 13 captured real responses",
    direct.length === 14 &&
      browserRequests.length === 24 &&
      responses.length === 13 &&
      p.requests.length === 51,
  );
  check(
    "all recorded direct and intercepted response statuses are 2xx",
    direct.every((x) => x.status >= 200 && x.status < 300) &&
      responses.every((x) => x.status === 200),
  );
  check(
    "only expected direct POST operations",
    isDeepStrictEqual(
      direct.filter((x) => x.method !== "GET").map((x) => [x.method, x.path]),
      [
        ["POST", "/api/v1/auth/gm/login"],
        ["POST", "/api/v1/gm/projects"],
        ["POST", "/api/v1/auth/login"],
        ["POST", "/api/v1/bugs"],
      ],
    ),
  );
  check(
    "only browser mutation is one login",
    isDeepStrictEqual(
      browserRequests.filter((x) => x.method !== "GET").map((x) => [x.method, x.path]),
      [["POST", "/api/v1/auth/login"]],
    ),
  );
  check(
    "no refused or cancelled-after-failure records",
    !p.requests.some((x) => ["refused", "request_cancelled_after_failure"].includes(x.kind)),
  );
  const bugPath = `/api/v1/bugs/${p.bugId}`;
  const projectPath = `/api/v1/projects/${p.projectId}`;
  check(
    "browser record-specific requests stay on this project/Bug",
    browserRequests.every(
      (x) => !x.path.startsWith("/api/v1/projects/") || x.path.startsWith(projectPath + "/"),
    ) &&
      browserRequests.every(
        (x) =>
          !x.path.startsWith("/api/v1/bugs/") ||
          x.path === bugPath ||
          x.path.startsWith(bugPath + "/"),
      ),
  );
  const login = browserRequests.find((x) => x.category === "login");
  check(
    "browser login body hash matches fresh employee/project",
    login.bodySha256 ===
      sha(JSON.stringify({ name: p.employee, projectId: p.projectId, client: "web" })),
  );
  check(
    "authentication raw bodies are not stored",
    direct
      .filter((x) => x.path.startsWith("/api/v1/auth/"))
      .every((x) => x.bodyStored === false && !x.rawPath) &&
      responses
        .filter((x) => x.category === "login")
        .every((x) => x.bodyStored === false && !x.rawPath),
  );
  check(
    "fresh project returned exact fixture id",
    labeled("fresh-project").id === p.projectId && labeled("fresh-project").active === true,
  );
  const created = labeled("one-bug"),
    initial = labeled("initial-detail"),
    final = labeled("final-detail");
  check(
    "one create receipt and detail share Bug/project/actor",
    created.bug.id === p.bugId &&
      initial.id === p.bugId &&
      initial.projectId === p.projectId &&
      initial.reporterId === p.actorId &&
      initial.ownerId === p.actorId &&
      initial.verificationOwnerId === p.actorId,
  );
  check(
    "create used expected text-only fresh intent",
    initial.title === "WEB_DETAIL_LOADING_FIXTURE_" + runId &&
      initial.description === initial.title &&
      created.replayed === false &&
      created.attachmentIds.length === 0 &&
      created.captureBundleId === null,
  );
  check("before/after Bug DTO identical", isDeepStrictEqual(initial, final));
  check(
    "before/after event bodies identical and one same-scope event",
    isDeepStrictEqual(labeled("initial-events"), labeled("final-events")) &&
      labeled("final-events").items.length === 1 &&
      labeled("final-events").items.every(
        (x) => x.projectId === p.projectId && x.bugId === p.bugId,
      ),
  );
  check(
    "final exact one Bug and empty comments/attachments",
    isDeepStrictEqual(
      labeled("final-list").items.map((x) => x.id),
      [p.bugId],
    ) &&
      labeled("final-comments").items.length === 0 &&
      labeled("final-attachments").items.length === 0,
  );
  const components = rawRows.filter(
    (x) => x.label?.endsWith("five-off") || x.category === "components",
  );
  check(
    "three retained component responses all five disabled and exact project",
    components.length === 3 &&
      components.every((x) => {
        const b = bodies.get(x);
        return (
          b.projectId === p.projectId &&
          isDeepStrictEqual(b.items.map((i) => i.key).sort(), [
            "build",
            "build_upload.single",
            "qingyu.sync",
            "relay.production",
            "upload.incremental",
          ]) &&
          b.items.every((i) => i.enabled === false && i.status === "disabled")
        );
      }),
  );

  const details = browserRequests.filter((x) => x.category === "detail");
  const detailResponses = responses.filter((x) => x.category === "detail");
  check(
    "three detail GETs match ordered plan",
    details.length === 3 &&
      details.every((x) => x.method === "GET" && x.path === bugPath) &&
      isDeepStrictEqual(
        p.detailPlan.requests.map((x) => x.id),
        details.map((x) => x.requestId),
      ) &&
      isDeepStrictEqual(
        p.detailPlan.requests.map((x) => x.mode),
        ["delay", "disconnect", "retry"],
      ),
  );
  check(
    "two genuine detail 200 bodies match original/final bytes",
    detailResponses.length === 2 &&
      detailResponses.every(
        (x) =>
          x.sha256 === rawRows.find((r) => r.label === "initial-detail").sha256 &&
          isDeepStrictEqual(bodies.get(x), initial),
      ),
  );
  const firstId = details[0].requestId,
    failureId = details[1].requestId,
    retryId = details[2].requestId;
  check(
    "no successful response attributed to injected request",
    !responses.some((x) => x.requestId === failureId) &&
      isDeepStrictEqual(p.detailPlan.responses, [firstId, retryId]),
  );
  const injection = p.holds.filter((x) => x.action === "injected_network_failure");
  check(
    "one recorded Failed transport injection without server status",
    injection.length === 1 &&
      injection[0].requestId === failureId &&
      injection[0].errorReason === "Failed" &&
      injection[0].responseStatus === null,
  );
  const held = p.holds.find((x) => x.action === "hold_detail_real_200");
  const releaseRecords = p.holds.filter((x) => x.action === "release_detail_unmodified");
  const ledgerRelease = releaseRecords.find((x) => x.category === "detail");
  check(
    "duplicate first-release records describe one ID/hash",
    releaseRecords.length === 2 &&
      releaseRecords.every((x) => x.requestId === firstId && x.sha256 === held.sha256) &&
      ledgerRelease.status === 200,
  );
  const state = (label) => p.checkpoints.find((x) => x.label === label && x.state);
  const shot = (label) => p.checkpoints.find((x) => x.label === label && x.kind === "screenshot");
  const pending = state("pending-real-200"),
    firstLoaded = state("first-real-200-loaded"),
    error = state("actual-catch-error"),
    retry = state("actual-retry-loaded");
  check(
    "pending actual DOM is loading without fabricated error",
    pending.state.present &&
      pending.state.loading &&
      !pending.state.loaded &&
      pending.state.errorTitle === "" &&
      pending.state.errorText === "",
  );
  check(
    "pending DOM and screenshot occur while real response held",
    Date.parse(held.at) <= Date.parse(pending.at) &&
      Date.parse(pending.at) <= Date.parse(shot("01-real-response-held-loading").at) &&
      Date.parse(shot("01-real-response-held-loading").at) <= Date.parse(ledgerRelease.at),
  );
  check(
    "first actual DOM loaded after original release",
    firstLoaded.state.loaded &&
      !firstLoaded.state.loading &&
      firstLoaded.state.errorTitle === "" &&
      firstLoaded.state.text.includes(initial.title) &&
      Date.parse(firstLoaded.at) > Date.parse(ledgerRelease.at),
  );
  check(
    "catch DOM and error screenshot follow transport injection",
    error.state.errorTitle === "Bug 详情读取失败" &&
      error.state.errorText === "Failed to fetch" &&
      !error.state.loaded &&
      Date.parse(error.at) > Date.parse(injection[0].at) &&
      Date.parse(shot("03-actual-network-catch-error").at) < Date.parse(details[2].at),
  );
  check(
    "retry actual DOM loaded and error cleared after real 200",
    retry.state.loaded &&
      !retry.state.loading &&
      retry.state.errorTitle === "" &&
      retry.state.errorText === "" &&
      retry.state.text.includes(initial.title) &&
      Date.parse(retry.at) > Date.parse(detailResponses[1].at) &&
      p.detailPlan.phase === "retry_confirmed",
  );
  const screenshots = p.checkpoints.filter((x) => x.kind === "screenshot");
  const screenshotRefs = [];
  check("four screenshot checkpoints", screenshots.length === 4);
  for (const item of screenshots) {
    assert.equal(
      canonical(item.path),
      canonical(join(runtime, item.label + ".png")),
      "EXACT_SCREENSHOT_REFUSED",
    );
    const publicRef = inspect(join(publicRoot, item.label + ".png"), publicRoot);
    const privateRef = inspect(item.path, runtime);
    const bytes = exactFile(join(publicRoot, item.label + ".png"), publicRoot);
    check(
      "screenshot public/private/proof hash " + item.label,
      publicRef.sha256 === privateRef.sha256 &&
        publicRef.sha256 === item.sha256 &&
        publicRef.bytes === item.sizeBytes,
    );
    check(
      "PNG dimensions " + item.label,
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        bytes.readUInt32BE(16) === 1440 &&
        bytes.readUInt32BE(20) === 1100,
    );
    screenshotRefs.push({ ...publicRef, privatePath: privateRef.path, width: 1440, height: 1100 });
  }
  const backgroundHolds = p.holds.filter((x) => x.action === "hold_background_components_real_200");
  check(
    "no background replies were actually held",
    backgroundHolds.length === 0 &&
      !p.holds.some((x) => x.action === "release_background_components_unmodified"),
  );
  check(
    "no timeout/release error and no unreleased response",
    p.unreleasedRealResponses.length === 0 &&
      !p.releaseFailure &&
      !p.closeFailure &&
      !p.failure &&
      !p.holds.some((x) => /expired|failed/u.test(x.action)),
  );
  const launched = p.processes.find((x) => x.phase === "launched"),
    closed = p.processes.find((x) => x.phase === "normal_close");
  check(
    "recorded owned browser identity and normal exit",
    launched.pid === 10812 &&
      closed.pid === launched.pid &&
      closed.exited === true &&
      canonical(launched.profile) === canonical(p.profile) &&
      Date.parse(closed.at) > Date.parse(retry.at),
  );
  const hostCheck = p.checks.find((x) => x.label === "API/Web processes unchanged");
  check(
    "recorded before/after API/Web process identities equal",
    isDeepStrictEqual(hostCheck.expected, hostCheck.actual) &&
      isDeepStrictEqual(p.hostBefore, hostCheck.actual) &&
      p.hostBefore.find((x) => x.port === 4419)?.pid === 22852 &&
      p.hostBefore.find((x) => x.port === 4274)?.pid === 20284,
  );
  const sourceRef = inspect(fileURLToPath(import.meta.url), publicRoot);
  const scanFiles = [
    ...originalBefore.filter((x) => !x.path.endsWith(".png")),
    sourceRef,
    inspect(join(publicRoot, "README.md"), publicRoot),
  ];
  const publicTextScan = scanFiles.map((file) => {
    const text = exactFile(file.path, publicRoot).toString("utf8");
    return {
      path: file.path,
      sha256: file.sha256,
      jwt: [...text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu)]
        .length,
      privateKey: [...text.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu)].length,
      literalBearer: [...text.matchAll(/Bearer\s+[A-Za-z0-9_-]{24,}/gu)].length,
    };
  });
  check(
    "public artifact text scan has no JWT/private-key/long-Bearer literals",
    publicTextScan.every((x) => x.jwt === 0 && x.privateKey === 0 && x.literalBearer === 0),
  );
  const originalAfter = originalNames.map((name) => inspect(join(publicRoot, name), publicRoot));
  check(
    "six original public artifacts unchanged throughout audit",
    isDeepStrictEqual(originalBefore, originalAfter),
  );
  const result = {
    schemaVersion: 1,
    status: checks.every((x) => x.passed)
      ? "passed_with_explicit_limits"
      : "failed_review_retained",
    runId,
    reviewedAt: new Date().toISOString(),
    reviewer: "/root/android_client",
    operator: "/root",
    scope: {
      newHttpRequests: 0,
      browserOrUiActions: 0,
      deviceActions: 0,
      serviceOrProcessActions: 0,
      liveProfileReads: 0,
      authenticationBodyReads: 0,
      originalFilesModified: 0,
    },
    checks,
    originalBefore,
    originalAfter,
    rawReferences,
    screenshotRefs,
    gateRef,
    publicationRef,
    postScopeRef,
    sourceRef,
    publicTextScan,
    facts: {
      projectId: p.projectId,
      actorId: p.actorId,
      bugId: p.bugId,
      totalRunMs: Date.parse(p.finishedAt) - Date.parse(p.startedAt),
      directApiCalls: direct.length,
      browserRequestRecords: browserRequests.length,
      interceptedRealResponseRecords: responses.length,
      recordedRequestLedgerRows: p.requests.length,
      originalRunChecks: p.checks.length,
      actualDetailGets: details.length,
      genuineDetail200s: detailResponses.length,
      firstResponseHeldMs: Date.parse(ledgerRelease.at) - Date.parse(held.at),
      backgroundRepliesHeld: backgroundHolds.length,
      componentIsolationUpperBoundMs:
        Date.parse(p.requests.find((x) => x.label === "final-detail").at) -
        Date.parse(p.holds.find((x) => x.action === "start_component_poll_isolation").at),
      componentIsolationUpperBoundBasis:
        "First final read follows releaseBackground in pinned source; no explicit end timestamp is persisted.",
      detailResponseSha256: detailResponses[0].sha256,
      firstDetailReleaseRecords: releaseRecords.length,
      firstDetailContinuationCallsFromPinnedSource: 1,
      initialAndFinalEventCount: labeled("initial-events").items.length,
      finalBugCount: labeled("final-list").items.length,
      commentCount: 0,
      attachmentCount: 0,
      recordedBrowserPid: launched.pid,
      recordedNormalBrowserExit: closed.exited,
    },
    visualInspection: [
      {
        file: screenshots[0].label + ".png",
        observed:
          "Centered loading message and close control; no failure panel in this captured frame.",
      },
      {
        file: screenshots[1].label + ".png",
        observed:
          "Fixture DLAB51A7D83D9740-1 with expected text, P3/pending state, zero images and one history entry; detail rendered without error panel.",
      },
      {
        file: screenshots[2].label + ".png",
        observed:
          "Bug detail read failure, Failed to fetch, and visible Retry control; no loaded detail content.",
      },
      {
        file: screenshots[3].label + ".png",
        observed:
          "Same fixture content/state visible after Retry, zero images and one history entry; error panel cleared.",
      },
    ],
    limitations: [
      "Independent audit of retained bytes and four screenshots, not a second live browser/API run or an independent packet capture.",
      "Browser request logs omit query/header values; exact query/project enforcement is attributable to the byte-pinned executed source. Some page GET response statuses are not captured by the configured response patterns.",
      "Second detail failure was injected by CDP before a server reply; it does not prove an actual API outage or a server error response.",
      "The isolation window was armed, but no subsequent component reply arrived to be held. Background hold release and 15-second expiry were not exercised live.",
      "The first held reply has two release log entries from the ledger and flow recorder; pinned source issues one actual continuation. No raw CDP command transcript is retained.",
      "Normal close and empty owned debug port are checks in pinned source; this review did not query current processes/ports, enumerate all browser children, or inspect a live profile.",
      "Eight current entry assets matched the publication manifest; the publication retained additional old hashed bundles. This is not a claim that the entire served directory contains only eight files.",
      "Four captured states do not prove all intermediate frames or every polling/fault timing. No image/comment mutations, multi-project races, component execution, or existing client drafts were tested here.",
      "Authentication response hashes cannot be recomputed from raw bodies because those bodies were deliberately not persisted; no credentials were read for this audit.",
    ],
  };
  const text = JSON.stringify(result, null, 2) + "\n";
  assert(
    !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_-]{24,}/u.test(
      text,
    ),
    "PUBLIC_REVIEW_SECRET_SHAPE",
  );
  writeFileSync(join(publicRoot, "artifact-review.json"), text, { flag: "wx" });
  console.log(
    JSON.stringify({
      status: result.status,
      checks: checks.length,
      failed: checks.filter((x) => !x.passed).map((x) => x.label),
      originalProofSha256: sha(proofBytes),
      reviewSha256: sha(text),
      sourceSha256: sourceRef.sha256,
      rawReferences: rawReferences.length,
      screenshotCount: screenshotRefs.length,
    }),
  );
  if (checks.some((x) => !x.passed)) process.exitCode = 1;
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--review") run();
  else console.log("not_run: artifact-only --review required");
}
