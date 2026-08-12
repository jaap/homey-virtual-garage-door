'use strict';

/**
 * Consistency checks between the generated app manifest, the compose
 * sources, the package metadata and the constants used by the app code.
 * These catch drift that `homey app validate` cannot see, such as the Flow
 * dropdown offering a state the device implementation does not accept.
 */

const fs = require('fs');
const path = require('path');

const VirtualGarageDoorDevice = require('../drivers/garagedoor/device');

const ROOT = path.join(__dirname, '..');
const manifest = require('../app.json');
const composeApp = require('../.homeycompose/app.json');
const composeCapability = require('../.homeycompose/capabilities/garagedoor_state.json');
const pkg = require('../package.json');

const { STATES } = VirtualGarageDoorDevice;

describe('app manifest', () => {
  test('identity and platform', () => {
    expect(manifest.id).toBe('com.jaap.virtualgaragedoor');
    expect(manifest.sdk).toBe(3);
    expect(manifest.platforms).toEqual(['local']);
    expect(manifest.permissions).toEqual([]);
  });

  test('versions in app.json, compose and package.json agree', () => {
    expect(manifest.version).toBe(composeApp.version);
    expect(manifest.version).toBe(pkg.version);
  });

  test('driver is a garagedoor-class device with the expected capabilities', () => {
    expect(manifest.drivers).toHaveLength(1);
    const [driver] = manifest.drivers;
    expect(driver.id).toBe('garagedoor');
    expect(driver.class).toBe('garagedoor');
    expect(driver.capabilities).toEqual(['garagedoor_closed', 'garagedoor_state']);
  });

  test('pairing is the minimal list_devices -> add_devices flow', () => {
    const [driver] = manifest.drivers;
    expect(driver.pair.map(view => view.template)).toEqual(['list_devices', 'add_devices']);
    expect(driver.pair[0].navigation).toEqual({ next: 'add_devices' });
  });

  test('flow cards exist and are scoped to this driver', () => {
    const triggers = manifest.flow.triggers.map(t => t.id).sort();
    expect(triggers).toEqual(['close_requested', 'garagedoor_state_changed', 'open_requested']);

    const actions = manifest.flow.actions.map(a => a.id).sort();
    expect(actions).toEqual(['request_close', 'request_open', 'set_state']);

    for (const card of [...manifest.flow.triggers, ...manifest.flow.actions]) {
      const deviceArg = card.args.find(arg => arg.type === 'device');
      expect(deviceArg).toEqual({
        type: 'device',
        name: 'device',
        filter: 'driver_id=garagedoor',
      });
    }
  });

  test('the state-changed trigger exposes the capability value as a token', () => {
    const trigger = manifest.flow.triggers.find(t => t.id === 'garagedoor_state_changed');
    // Homey fires `<capability id>_changed` automatically on setCapabilityValue;
    // the token must be named after the capability for the value to be attached.
    expect(trigger.tokens).toHaveLength(1);
    expect(trigger.tokens[0].name).toBe('garagedoor_state');
    expect(trigger.tokens[0].type).toBe('string');
  });

  test('the set_state action offers exactly the states the device accepts', () => {
    const action = manifest.flow.actions.find(a => a.id === 'set_state');
    expect(action).toBeDefined();

    const stateArg = action.args.find(arg => arg.name === 'state');
    expect(stateArg.type).toBe('dropdown');
    expect(stateArg.values.map(v => v.id)).toEqual(STATES);
    // dropdown values must use `title` (i18n object), not the SDK2-era `label`
    for (const value of stateArg.values) {
      expect(value.title).toBeDefined();
      expect(value.title.en).toEqual(expect.any(String));
      expect(value.label).toBeUndefined();
    }
  });

  test('the garagedoor_state capability enumerates exactly the states the device accepts', () => {
    const capability = manifest.capabilities.garagedoor_state;
    expect(capability.type).toBe('enum');
    expect(capability.getable).toBe(true);
    expect(capability.setable).toBe(false);
    expect(capability.values.map(v => v.id)).toEqual(STATES);
    // generated manifest must match the compose source
    expect(capability).toEqual(composeCapability);
  });

  test('every referenced asset exists', () => {
    const paths = [
      ...Object.values(manifest.images),
      ...Object.values(manifest.drivers[0].images),
      manifest.capabilities.garagedoor_state.icon,
      '/assets/icon.svg',
      '/drivers/garagedoor/assets/icon.svg',
    ];
    for (const assetPath of paths) {
      const resolved = path.join(ROOT, assetPath.replace(/^\//, ''));
      expect(fs.existsSync(resolved)).toBe(true);
    }
  });

  test.each([
    ['app', 'images', { small: [250, 175], large: [500, 350], xlarge: [1000, 700] }],
    ['driver', 'drivers/garagedoor images', { small: [75, 75], large: [500, 500], xlarge: [1000, 1000] }],
  ])('generated %s images have the sizes Homey requires', (kind, _label, expected) => {
    const images = kind === 'app' ? manifest.images : manifest.drivers[0].images;
    for (const [size, [width, height]] of Object.entries(expected)) {
      const buffer = fs.readFileSync(path.join(ROOT, images[size].replace(/^\//, '')));
      // PNG signature, then IHDR: width and height as big-endian uint32
      expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(buffer.readUInt32BE(16)).toBe(width);
      expect(buffer.readUInt32BE(20)).toBe(height);
    }
  });
});
