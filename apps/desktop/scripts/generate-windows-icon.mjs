import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2];
if (!output) throw new Error("Usage: node generate-windows-icon.mjs <output.ico>");

const size = 256;
const samples = 4;
const colors = {
  background: [0x12, 0x3b, 0x3a, 0xff],
  foreground: [0xf4, 0xf1, 0xe8, 0xff],
  accent: [0xe9, 0x9a, 0x4e, 0xff],
  transparent: [0, 0, 0, 0],
};

function inRoundedRectangle(x, y) {
  const radius = 56;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function sampleColor(x, y) {
  let color = inRoundedRectangle(x, y) ? colors.background : colors.transparent;
  const ringDistance = Math.abs(Math.hypot(x - 118, y - 116) - 63);
  if (ringDistance <= 13 || distanceToSegment(x, y, 161, 162, 199, 200) <= 13) {
    color = colors.foreground;
  }
  if (
    distanceToSegment(x, y, 87, 118, 110, 141) <= 9.5 ||
    distanceToSegment(x, y, 110, 141, 163, 86) <= 9.5
  ) {
    color = colors.accent;
  }
  return color;
}

const rgba = Buffer.alloc(size * size * 4);
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const totals = [0, 0, 0, 0];
    for (let sy = 0; sy < samples; sy += 1) {
      for (let sx = 0; sx < samples; sx += 1) {
        const color = sampleColor(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples);
        for (let channel = 0; channel < 4; channel += 1) totals[channel] += color[channel];
      }
    }
    const offset = (y * size + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      rgba[offset + channel] = Math.round(totals[channel] / (samples * samples));
    }
  }
}

const xorBytes = size * size * 4;
const maskStride = Math.ceil(size / 32) * 4;
const maskBytes = maskStride * size;
const imageBytes = 40 + xorBytes + maskBytes;
const ico = Buffer.alloc(6 + 16 + imageBytes);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 0;
ico[7] = 0;
ico[8] = 0;
ico[9] = 0;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(imageBytes, 14);
ico.writeUInt32LE(22, 18);

const dib = 22;
ico.writeUInt32LE(40, dib);
ico.writeInt32LE(size, dib + 4);
ico.writeInt32LE(size * 2, dib + 8);
ico.writeUInt16LE(1, dib + 12);
ico.writeUInt16LE(32, dib + 14);
ico.writeUInt32LE(0, dib + 16);
ico.writeUInt32LE(xorBytes, dib + 20);

const pixels = dib + 40;
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const source = (y * size + x) * 4;
    const destination = pixels + ((size - 1 - y) * size + x) * 4;
    ico[destination] = rgba[source + 2];
    ico[destination + 1] = rgba[source + 1];
    ico[destination + 2] = rgba[source];
    ico[destination + 3] = rgba[source + 3];
  }
}

const mask = pixels + xorBytes;
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const alpha = rgba[(y * size + x) * 4 + 3];
    if (alpha !== 0) continue;
    const destination = mask + (size - 1 - y) * maskStride + Math.floor(x / 8);
    ico[destination] |= 0x80 >> (x % 8);
  }
}

await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, ico);
console.log(JSON.stringify({ output: path.resolve(output), bytes: ico.length }));
