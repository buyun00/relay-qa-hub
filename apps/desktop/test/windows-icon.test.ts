import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(desktopRoot, "scripts", "generate-windows-icon.mjs");

test("Windows icon contains transparent tray-sized images and the full EXE image", () => {
  const root = mkdtempSync(path.join(tmpdir(), "qa-hub-windows-icon-"));
  const output = path.join(root, "RelayQaHub.ico");
  try {
    execFileSync(process.execPath, [generator, output], { stdio: "pipe" });
    const ico = readFileSync(output);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);

    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = 6 + index * 16;
      const size = ico[entry] === 0 ? 256 : ico[entry];
      const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1];
      const imageBytes = ico.readUInt32LE(entry + 8);
      const imageOffset = ico.readUInt32LE(entry + 12);
      assert.equal(height, size);
      assert.equal(ico.readUInt16LE(entry + 6), 32);
      assert.ok(imageOffset + imageBytes <= ico.length);

      const pixelBytes = size * size * 4;
      const alphaValues = new Set<number>();
      for (let offset = imageOffset + 40 + 3; offset < imageOffset + 40 + pixelBytes; offset += 4) {
        alphaValues.add(ico[offset] ?? -1);
      }
      assert.ok(alphaValues.has(0), `${size}px image must preserve transparent corners`);
      assert.ok(
        [...alphaValues].some((alpha) => alpha > 0),
        `${size}px image must contain visible pixels`,
      );
      sizes.push(size);
    }

    assert.deepEqual(sizes, [16, 20, 24, 32, 48, 64, 128, 256]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
