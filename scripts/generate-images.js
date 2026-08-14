'use strict';

/**
 * Regenerates the PNG images required by the Homey app manifest (which are
 * committed) using only Node.js built-ins — run `npm run images` after
 * changing the artwork or brand color, then commit the result.
 *
 * The artwork mirrors the icon.svg files: a white glyph (the garage for
 * the app and door drivers, the fence gate for the gate driver) centered
 * on the brand-color background at 52% of the image height, anti-aliased
 * with signed distance fields.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

const BACKGROUND = [0x2e, 0x56, 0xb5]; // must match brandColor in .homeycompose/app.json
const GLYPH_COLOR = [0xff, 0xff, 0xff];
const GLYPH_HEIGHT_FRACTION = 0.52;

const DRIVERS = [
  { id: 'flow-door', glyph: 'garage' },
  { id: 'managed-door', glyph: 'garage' },
  { id: 'gate', glyph: 'gate' },
];

const IMAGES = [
  { file: 'assets/images/small.png', width: 250, height: 175, glyph: 'garage' },
  { file: 'assets/images/large.png', width: 500, height: 350, glyph: 'garage' },
  { file: 'assets/images/xlarge.png', width: 1000, height: 700, glyph: 'garage' },
  ...DRIVERS.flatMap(({ id, glyph }) => [
    { file: `drivers/${id}/assets/images/small.png`, width: 75, height: 75, glyph },
    { file: `drivers/${id}/assets/images/large.png`, width: 500, height: 500, glyph },
    { file: `drivers/${id}/assets/images/xlarge.png`, width: 1000, height: 1000, glyph },
  ]),
];

// --- glyph geometry, in the icon's 0..100 coordinate space ---------------

// Wide garage silhouette: apex, eaves, feet (mirrors assets/icon.svg).
const GARAGE = [
  [50, 12],
  [96, 38],
  [96, 94],
  [4, 94],
  [4, 38],
];

// Door opening cut out of the garage, open at the bottom.
const DOOR = { x: 14, y: 48, w: 72, h: 48 };

// Four rounded sectional-door slats.
const SLATS = [
  { x: 18, y: 52, w: 64, h: 7.5, r: 2.5 },
  { x: 18, y: 62.5, w: 64, h: 7.5, r: 2.5 },
  { x: 18, y: 73, w: 64, h: 7.5, r: 2.5 },
  { x: 18, y: 83.5, w: 64, h: 7.5, r: 2.5 },
];

// Two-leaf swing gate between ball-topped posts, hanging just above the
// ground (mirrors drivers/gate/assets/icon.svg).
const GATE_RECTS = [
  { x: 6.5, y: 23, w: 9, h: 9, r: 4.5 }, // finials
  { x: 84.5, y: 23, w: 9, h: 9, r: 4.5 },
  { x: 6, y: 30, w: 10, h: 63, r: 2.5 }, // posts
  { x: 84, y: 30, w: 10, h: 63, r: 2.5 },
  { x: 14, y: 38, w: 32, h: 5, r: 2.5 }, // rails, reaching into the posts
  { x: 14, y: 83, w: 32, h: 5, r: 2.5 },
  { x: 54, y: 38, w: 32, h: 5, r: 2.5 },
  { x: 54, y: 83, w: 32, h: 5, r: 2.5 },
  { x: 20, y: 38, w: 4, h: 50, r: 2 }, // bars
  { x: 31, y: 38, w: 4, h: 50, r: 2 },
  { x: 42, y: 38, w: 4, h: 50, r: 2 },
  { x: 54, y: 38, w: 4, h: 50, r: 2 },
  { x: 65, y: 38, w: 4, h: 50, r: 2 },
  { x: 76, y: 38, w: 4, h: 50, r: 2 },
];

// Signed distance to a convex polygon (negative inside): the maximum of the
// signed distances to the outward half-plane of each edge.
function polygonEdges(points) {
  const edges = [];
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const ex = x1 - x0;
    const ey = y1 - y0;
    const len = Math.hypot(ex, ey);
    // outward normal for clockwise winding in a y-down coordinate space
    const nx = ey / len;
    const ny = -ex / len;
    edges.push({ nx, ny, b: nx * x0 + ny * y0 });
  }
  return edges;
}

const GARAGE_EDGES = polygonEdges(GARAGE);

function garageBodyDistance(x, y) {
  let d = -Infinity;
  for (const { nx, ny, b } of GARAGE_EDGES) {
    d = Math.max(d, nx * x + ny * y - b);
  }
  return d;
}

// Signed distance to an axis-aligned rectangle with corner radius r.
function rectDistance(x, y, rect) {
  const r = rect.r || 0;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hx = rect.w / 2 - r;
  const hy = rect.h / 2 - r;
  const qx = Math.abs(x - cx) - hx;
  const qy = Math.abs(y - cy) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - r;
}

const GLYPHS = {
  // garage minus door opening, plus the slats
  garage(x, y) {
    let d = Math.max(garageBodyDistance(x, y), -rectDistance(x, y, DOOR));
    for (const slat of SLATS) {
      d = Math.min(d, rectDistance(x, y, slat));
    }
    return d;
  },
  // union of the gate's posts, rails and bars
  gate(x, y) {
    let d = Infinity;
    for (const rect of GATE_RECTS) {
      d = Math.min(d, rectDistance(x, y, rect));
    }
    return d;
  },
};

// --- rasterization -------------------------------------------------------

function renderImage(width, height, glyphDistance) {
  const glyphSize = height * GLYPH_HEIGHT_FRACTION; // pixels for 100 glyph units
  const scale = glyphSize / 100;
  const offsetX = (width - glyphSize) / 2;
  const offsetY = (height - glyphSize) / 2;

  const stride = 1 + width * 3; // one PNG filter byte per row
  const raw = Buffer.alloc(height * stride);

  for (let py = 0; py < height; py++) {
    const row = py * stride;
    raw[row] = 0; // filter type 0 (None)
    const gy = (py + 0.5 - offsetY) / scale;
    for (let px = 0; px < width; px++) {
      const gx = (px + 0.5 - offsetX) / scale;
      const distancePx = glyphDistance(gx, gy) * scale;
      const coverage = Math.min(1, Math.max(0, 0.5 - distancePx));
      const at = row + 1 + px * 3;
      for (let c = 0; c < 3; c++) {
        raw[at + c] = Math.round(BACKGROUND[c] + (GLYPH_COLOR[c] - BACKGROUND[c]) * coverage);
      }
    }
  }
  return raw;
}

// --- minimal PNG encoder -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(...buffers) {
  let c = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) {
      c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeBuffer, data));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, raw) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- main ----------------------------------------------------------------

// Checkouts from when the images were gitignored can still hold generated
// images of since-removed drivers after a git pull, and the Homey CLI
// refuses to build while a driver directory without a driver.compose.json
// exists. Prune such leftovers, but never touch a directory that holds a
// real driver manifest.
for (const leftover of ['garagedoor']) {
  const dir = path.join(ROOT, 'drivers', leftover);
  if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, 'driver.compose.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`removed leftover drivers/${leftover} (generated assets from a removed driver)`);
  }
}

for (const { file, width, height, glyph } of IMAGES) {
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(width, height, renderImage(width, height, GLYPHS[glyph])));
  console.log(`generated ${file} (${width}x${height}, ${glyph})`);
}
