'use strict';

/**
 * Regenerates the PNG images required by the Homey app manifest (which are
 * committed) using only Node.js built-ins — run `npm run images` after
 * changing the artwork, then commit the result.
 *
 * The images are flat-design illustrations rendered with signed distance
 * fields and painter's-algorithm compositing:
 *  - app images: a garage with its door mid-travel next to the auto-closing
 *    gate, on a soft sky gradient (the App Store wants a designed graphic,
 *    not an icon on a plain background);
 *  - driver images: a unique product-style graphic per driver on a white
 *    background, as the App Store guidelines require.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

const C = {
  white: [0xff, 0xff, 0xff],
  skyTop: [0xe9, 0xf0, 0xfa],
  skyBottom: [0xfb, 0xfd, 0xff],
  ground: [0xdc, 0xe5, 0xf2],
  shadow: [0x33, 0x41, 0x5c],
  rim: [0x9d, 0xb0, 0xcc],
  roof: [0x33, 0x41, 0x5c],
  wall: [0xf4, 0xf7, 0xfb],
  frame: [0xc7, 0xd2, 0xe4],
  doorBase: [0x26, 0x47, 0x9b],
  slat: [0x3d, 0x66, 0xc9],
  opening: [0x1b, 0x23, 0x33],
  green: [0x2f, 0xbf, 0x71],
  grey: [0xa9, 0xb8, 0xd4],
};

// --- signed distance helpers (negative inside) ---------------------------

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

function poly(points) {
  const edges = polygonEdges(points);
  return (x, y) => {
    let d = -Infinity;
    for (const { nx, ny, b } of edges) {
      d = Math.max(d, nx * x + ny * y - b);
    }
    return d;
  };
}

function rect(rx, ry, w, h, r = 0) {
  const cx = rx + w / 2;
  const cy = ry + h / 2;
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hx;
    const qy = Math.abs(y - cy) - hy;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
    const inside = Math.min(Math.max(qx, qy), 0);
    return outside + inside - r;
  };
}

const circle = (cx, cy, r) => rect(cx - r, cy - r, 2 * r, 2 * r, r);
const inset = (dist, amount) => (x, y) => dist(x, y) + amount;
const intersect = (a, b) => (x, y) => Math.max(a(x, y), b(x, y));
const below = edgeY => (x, y) => edgeY - y; // inside where y > edgeY
const transform = (dist, { dx = 0, dy = 0, s = 1 }) => (x, y) => dist((x - dx) / s, (y - dy) / s) * s;

// --- the buildings, in their own 0..100 coordinate space -----------------

/**
 * A garage facade: rim outline, dark roof band, light walls, door frame and
 * either a closed sectional door or a raised one showing the dark opening.
 * With `sensors`, two contact-sensor dots mark the managed variant.
 */
function garageLayers({ raised = false, sensors = false } = {}) {
  const building = poly([[50, 14], [94, 40], [94, 90], [6, 90], [6, 40]]);
  const layers = [
    { dist: rect(10, 86.8, 80, 4.6, 2.3), color: C.shadow, alpha: 0.16, blur: 5 },
    { dist: building, color: C.rim },
    { dist: inset(building, 1.6), color: C.roof },
    { dist: intersect(inset(building, 1.6), below(43)), color: C.wall },
    { dist: rect(19, 49, 62, 41, 1.5), color: C.frame },
    { dist: rect(22, 52, 56, 38), color: raised ? C.opening : C.doorBase },
  ];
  const slatYs = raised
    ? [52, 56.6, 61.2] // compressed stack at the top of the opening
    : [53.5, 63, 72.5, 82];
  for (const y of slatYs) {
    layers.push({ dist: rect(24, y, 52, raised ? 3.6 : 7, 1.6), color: C.slat });
  }
  if (sensors) {
    layers.push({ dist: circle(87.6, 86, 2.7), color: C.green });
    layers.push({ dist: circle(87.6, 54, 2.7), color: C.grey });
  }
  return layers;
}

/** The two-leaf entrance gate, colored like the rest of the family. */
function gateLayers() {
  const layers = [
    { dist: rect(8, 89.2, 84, 4.2, 2.1), color: C.shadow, alpha: 0.16, blur: 5 },
    { dist: circle(11, 26.5, 4.5), color: C.roof },
    { dist: circle(89, 26.5, 4.5), color: C.roof },
    { dist: rect(6, 30, 10, 63, 2.5), color: C.roof },
    { dist: rect(84, 30, 10, 63, 2.5), color: C.roof },
  ];
  for (const [rx, w] of [[14, 32], [54, 32]]) {
    layers.push({ dist: rect(rx, 38, w, 5, 2.5), color: C.slat });
    layers.push({ dist: rect(rx, 83, w, 5, 2.5), color: C.slat });
  }
  for (const rx of [20, 31, 42, 54, 65, 76]) {
    layers.push({ dist: rect(rx, 38, 4, 50, 2), color: C.slat });
  }
  return layers;
}

const offsetLayers = (layers, t) => layers.map(layer => ({ ...layer, dist: transform(layer.dist, t) }));

// --- scenes --------------------------------------------------------------

const SCENES = {
  app: {
    background: (x, y) => {
      const t = Math.min(1, Math.max(0, y / 100));
      return C.skyTop.map((v, i) => v + (C.skyBottom[i] - v) * t);
    },
    layers: [
      { dist: below(84), color: C.ground },
      ...offsetLayers(garageLayers({ raised: true }), { dx: -4, dy: 84 - 90 * 0.9, s: 0.9 }),
      ...offsetLayers(gateLayers(), { dx: 82, dy: 84 - 93 * 0.4, s: 0.4 }),
    ],
  },
  'flow-door': {
    background: () => C.white,
    layers: garageLayers({ raised: false }),
  },
  'managed-door': {
    background: () => C.white,
    layers: garageLayers({ raised: true, sensors: true }),
  },
  gate: {
    background: () => C.white,
    layers: gateLayers(),
  },
};

const IMAGES = [
  { file: 'assets/images/small.png', width: 250, height: 175, scene: 'app' },
  { file: 'assets/images/large.png', width: 500, height: 350, scene: 'app' },
  { file: 'assets/images/xlarge.png', width: 1000, height: 700, scene: 'app' },
  ...['flow-door', 'managed-door', 'gate'].flatMap(driver => [
    { file: `drivers/${driver}/assets/images/small.png`, width: 75, height: 75, scene: driver },
    { file: `drivers/${driver}/assets/images/large.png`, width: 500, height: 500, scene: driver },
    { file: `drivers/${driver}/assets/images/xlarge.png`, width: 1000, height: 1000, scene: driver },
  ]),
];

// --- rasterization -------------------------------------------------------

function renderScene(width, height, scene, margin = 0.82) {
  // scene units: the y axis spans 0..100 over `margin` of the image height,
  // centered; x is centered on 50 with the same scale
  const unit = (height * margin) / 100;
  const offsetY = (height - 100 * unit) / 2;

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);

  for (let py = 0; py < height; py++) {
    const row = py * stride;
    raw[row] = 0; // filter type 0 (None)
    const y = (py + 0.5 - offsetY) / unit;
    for (let px = 0; px < width; px++) {
      const x = (px + 0.5 - width / 2) / unit + 50;
      let color = scene.background(x, y);
      for (const layer of scene.layers) {
        const distancePx = layer.dist(x, y) * unit;
        const soft = Math.max(1, (layer.blur || 0) * unit);
        const coverage = Math.min(1, Math.max(0, 0.5 - distancePx / soft)) * (layer.alpha ?? 1);
        if (coverage > 0) {
          color = color.map((v, i) => v + (layer.color[i] - v) * coverage);
        }
      }
      const at = row + 1 + px * 3;
      for (let c = 0; c < 3; c++) {
        raw[at + c] = Math.round(color[c]);
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

for (const { file, width, height, scene } of IMAGES) {
  const target = path.join(ROOT, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(width, height, renderScene(width, height, SCENES[scene])));
  console.log(`generated ${file} (${width}x${height}, ${scene})`);
}
