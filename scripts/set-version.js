'use strict';

/**
 * Sets the app version in every file that carries it, keeping them in sync
 * (the manifest tests assert they agree):
 *
 *   npm run set-version 0.6.0
 *
 * Commit the result, let CI go green, then create a GitHub release tagged
 * v0.6.0 — the publish workflow refuses tags that do not match the version.
 */

const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: npm run set-version <major.minor.patch>');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
for (const file of ['.homeycompose/app.json', 'app.json', 'package.json']) {
  const target = path.join(ROOT, file);
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  data.version = version;
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`${file} → ${version}`);
}
