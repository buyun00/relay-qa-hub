import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isUninstallShutdownRequest,
  QA_HUB_UNINSTALL_SHUTDOWN_ARGUMENT,
} from "../src/uninstall-shutdown.js";

test("uninstall shutdown request accepts only the exact standalone argument", () => {
  assert.equal(
    isUninstallShutdownRequest(["RelayQaHubTeam.exe", QA_HUB_UNINSTALL_SHUTDOWN_ARGUMENT]),
    true,
  );
  assert.equal(isUninstallShutdownRequest(["--qa-hub-uninstall-shutdown=1"]), false);
  assert.equal(isUninstallShutdownRequest([null, 1, undefined]), false);
});

test("desktop routes uninstall probes through the singleton and bypasses normal startup", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const secondInstanceHandler = source.slice(
    source.indexOf("function handleSecondInstanceArguments"),
    source.indexOf("function loadTrayImage"),
  );
  assert.match(
    secondInstanceHandler,
    /isUninstallShutdownRequest\(args\)[\s\S]+quitApplication\(\);[\s\S]+parseBugDeepLink/u,
  );
  const startup = source.slice(source.indexOf("const initialUninstallShutdownRequest"));
  assert.match(
    startup,
    /app\.on\("second-instance"[\s\S]+handleSecondInstanceArguments\(commandLine\)[\s\S]+if \(initialUninstallShutdownRequest\)[\s\S]+quitApplication\(\);[\s\S]+else \{[\s\S]+\.then\(startApplication\)/u,
  );
});
