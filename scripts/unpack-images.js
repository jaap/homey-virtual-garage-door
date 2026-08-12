'use strict';

/**
 * Materializes the PNG images required by the Homey app manifest from
 * scripts/image-assets.json, where they are stored base64-encoded so the
 * repository can be maintained through text-only tooling (e.g. the GitHub
 * API). Runs automatically via the npm `prepare` script on `npm install`.
 *
 * The PNGs themselves are gitignored; if you prefer tracking them as real
 * binary files, run this once, `git add -f` the images and delete this
 * script, scripts/image-assets.json and the `prepare` entry in package.json.
 */

const fs = require('fs');
const path = require('path');

const assets = require('./image-assets.json');
const root = path.join(__dirname, '..');

for (const [relativePath, base64] of Object.entries(assets)) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  console.log(`unpacked ${relativePath}`);
}
