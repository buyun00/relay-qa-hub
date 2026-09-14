import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cleaner = readFileSync(new URL("./legacy-client-cleaner.nsi", import.meta.url), "utf8");
const builder = readFileSync(new URL("./build-legacy-client-cleaner.mjs", import.meta.url), "utf8");
const distribution = readFileSync(
  new URL("./publish-lan-distribution.mjs", import.meta.url),
  "utf8",
);

test("legacy cleaner is restricted to four marker-bound obsolete clients", () => {
  for (const [directory, instanceId] of [
    ["RelayQaHubLAN-v22-0911", "qa-hub-lan-v22-0911"],
    ["RelayQaHubPreview", "qa-hub-preview-7c86"],
    ["RelayQaHubPreview-final-sol-0909", "qa-hub-preview-final-sol-0909"],
    ["RelayQaHubPreview-v21-e2e-fresh-0910", "qa-hub-preview-v21-e2e-fresh-0910"],
  ]) {
    assert.match(cleaner, new RegExp(`"${directory}"[\\s\\S]+"${instanceId}"`, "u"));
  }
  assert.match(
    cleaner,
    /GetFileAttributesW\(w "\$TargetDirectory"\)[\s\S]+IntOp \$1 \$0 & 0x400[\s\S]+IfFileExists "\$TargetDirectory\\\.preview-instance-id"[\s\S]+IfFileExists "\$TargetDirectory\\\$TargetExecutable\.exe"[\s\S]+StrCmp \$ExistingIdentity \$TargetInstanceId cleanup_target_verified cleanup_target_invalid/u,
  );
  assert.doesNotMatch(
    cleaner,
    /RelayQaHubTeam-v22-0911|"RelayQaHub"|taskkill|Stop-Process|TerminateProcess|\$APPDATA/u,
  );
  assert.match(
    cleaner,
    /MessageBox MB_ICONQUESTION\|MB_YESNO[\s\S]+current Team Edition[\s\S]+local drafts will be kept/u,
  );
});

test("legacy cleaner preserves shared team registration and schedules locked files", () => {
  assert.match(
    cleaner,
    /ReadRegStr \$0 HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$TargetUninstallKey" "InstallLocation"\s+StrCmp \$0 "\$TargetDirectory" cleanup_delete_uninstall_key/u,
  );
  assert.match(
    cleaner,
    /ReadRegStr \$0 HKCU "Software\\Classes\\\$TargetProtocol\\shell\\open\\command" ""[\s\S]+StrCmp \$0 \$1 cleanup_delete_protocol/u,
  );
  assert.match(cleaner, /RMDir \/r "\$TargetDirectory"/u);
  assert.match(cleaner, /RMDir \/r \/REBOOTOK "\$TargetDirectory"/u);
  assert.match(cleaner, /SetRebootFlag true/u);
  assert.match(cleaner, /Restart Windows once to finish removing them/u);
});

test("legacy cleaner publisher uses clean source, pinned tools, unique bytes and HTTP readback", () => {
  assert.match(builder, /assertCleanPreviewPackageSource\(config\.sourceRoot\)/u);
  assert.match(builder, /verifyPinnedPackageToolchain/u);
  assert.match(builder, /publishFileExclusiveDurable/u);
  assert.match(builder, /publishVersionedJson/u);
  assert.match(builder, /downloaded\.equals\(bytes\)/u);
  assert.match(builder, /Relay-QA-Hub-旧版本清理工具-\$\{releaseId\}\.exe/u);
  assert.match(distribution, /qa-hub-legacy-cleaner-latest\.json/u);
  assert.match(distribution, /LEGACY_CLEANER_BINDING_MISMATCH/u);
  assert.match(distribution, /下载旧版本清理工具/u);
});
