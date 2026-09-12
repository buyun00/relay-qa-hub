import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const output = process.argv[2];
if (!output) throw new Error("Usage: node generate-team-windows-icon.mjs <output.ico>");

const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
const samples = 4;
const colors = {
  background: [0x12, 0x3b, 0x3a, 0xff],
  foreground: [0xf4, 0xf1, 0xe8, 0xff],
  accent: [0xe9, 0x9a, 0x4e, 0xff],
  transparent: [0, 0, 0, 0],
};

function inRoundedRectangle(x, y, size) {
  const radius = (56 / 256) * size;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function inCircle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) <= radius;
}

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function sampleColor(x, y, size) {
  const scale = size / 256;
  let color = inRoundedRectangle(x, y, size) ? colors.background : colors.transparent;
  const point = (value) => value * scale;

  if (
    inCircle(x, y, point(128), point(76), point(28)) ||
    inCircle(x, y, point(73), point(102), point(20)) ||
    inCircle(x, y, point(183), point(102), point(20)) ||
    inEllipse(x, y, point(128), point(160), point(62), point(50)) ||
    inEllipse(x, y, point(68), point(169), point(43), point(38)) ||
    inEllipse(x, y, point(188), point(169), point(43), point(38))
  ) {
    color = colors.foreground;
  }
  if (
    distanceToSegment(x, y, point(103), point(157), point(122), point(176)) <= point(9) ||
    distanceToSegment(x, y, point(122), point(176), point(164), point(131)) <= point(9)
  ) {
    color = colors.accent;
  }
  return color;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const color = sampleColor(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples, size);
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
  const dib = Buffer.alloc(40 + xorBytes + maskBytes);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(xorBytes, 20);

  const pixels = 40;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = (y * size + x) * 4;
      const destination = pixels + ((size - 1 - y) * size + x) * 4;
      dib[destination] = rgba[source + 2];
      dib[destination + 1] = rgba[source + 1];
      dib[destination + 2] = rgba[source];
      dib[destination + 3] = rgba[source + 3];
    }
  }

  const mask = pixels + xorBytes;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = rgba[(y * size + x) * 4 + 3];
      if (alpha !== 0) continue;
      const destination = mask + (size - 1 - y) * maskStride + Math.floor(x / 8);
      dib[destination] |= 0x80 >> (x % 8);
    }
  }
  return dib;
}

const images = sizes.map((size) => ({ size, bytes: renderIcon(size) }));
const directoryBytes = 6 + images.length * 16;
const totalBytes = directoryBytes + images.reduce((total, image) => total + image.bytes.length, 0);
const ico = Buffer.alloc(totalBytes);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(images.length, 4);

let imageOffset = directoryBytes;
for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16;
  ico[entry] = image.size === 256 ? 0 : image.size;
  ico[entry + 1] = image.size === 256 ? 0 : image.size;
  ico[entry + 2] = 0;
  ico[entry + 3] = 0;
  ico.writeUInt16LE(1, entry + 4);
  ico.writeUInt16LE(32, entry + 6);
  ico.writeUInt32LE(image.bytes.length, entry + 8);
  ico.writeUInt32LE(imageOffset, entry + 12);
  image.bytes.copy(ico, imageOffset);
  imageOffset += image.bytes.length;
}

await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, ico);
console.log(JSON.stringify({ output: path.resolve(output), bytes: ico.length, sizes }));
