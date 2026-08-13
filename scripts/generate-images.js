'use strict';

/**
 * Generates the PNG images required by the Homey app manifest using only
 * Node.js built-ins, so the repository can stay text-only. Runs
 * automatically via the npm `prepare` script on `npm install`.
 *
 * The artwork mirrors assets/icon.svg: a white garage-door glyph centered
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

const DRIVERS = ['flow-door', 'managed-door', 'gate'];

const IMAGES = [
  { file: 'assets/images/small.png', width: 250, height: 175 },
  { file: 'assets/images/large.png', width: 500, height: 350 },
  { file: 'assets/images/xlarge.png', width: 1000, height: 700 },
  ...DRIVERS.flatMap(driver => [
    { file: `drivers/${driver}/assets/images/small.png`, width: 75, height: 75 },
    { file: `drivers/${driver}/assets/images/large.png`, width: 500, height: 500 },
    { file: `drivers/${driver}/assets/images/xlarge.png`, width: 1000, height: 1000 },
  ]),
];

// --- glyph geometry, in the icon's 0..100 coordinate space ---------------

// Convex house silhouette: apex, eaves, feet.
const HOUSE = [
  [50, 7],
  [96, 41],
  [96, 94],
  [4, 94],
  [4, 41],
];

// Door opening cut out of the house, open at the bottom.
const DOOR = { x: 18, y: 53.5, w: 64, h: 42 };

// Three rounded door slats.
const SLATS = [
  { x: 23, y: 59, w: 54, h: 8, r: 2.5 },
  { x: 23, y: 72, w: 54, h: 8, r: 2.5 },
  { x: 23, y: 85, w: 54, h: 8, r: 2.5 },
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

const HOUSE_EDGES = polygonEdges(HOUSE);

function houseDistance(x, y) {
  let d = -Infinity;
  for (const { nx, ny, b } of HOUSE_EDGES) {
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

function glyphDistance(x, y) {
  // house minus door opening, plus the slats
  let d = Math.max(houseDistance(x, y), -rectDistance(x, y, DOOR));
  for (const slat of SLATS) {
    d = Math.min(d, rectDistance(x, y, slat));
  }
  return d;
}

// --- rasterization -------------------------------------------------------

function renderImage(width, height) {
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

// Drivers removed from the repository leave their generated (gitignored)
// images behind after a git pull, and the Homey CLI refuses to build while
// a driver directory without a driver.compose.json exists. Prune such
// leftovers, but never touch a directory that holds a real driver manifest.
for (const leftover of ['garagedoor']) {
  const dir = path.join(ROOT, 'drivers', leftover);
  if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, 'driver.compose.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`removed leftover drivers/${leftover} (generated assets from a removed driver)`);
  }
}

for (const { file, width, height } of IMAGES) {
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(width, height, renderImage(width, height)));
  console.log(`generated ${file} (${width}x${height})`);
}
