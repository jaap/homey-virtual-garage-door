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

  test('request triggers exist and are scoped to this driver', () => {
    const triggers = manifest.flow.triggers.map(t => t.id).sort();
    expect(triggers).toEqual(['close_requested', 'open_requested']);

    for (const trigger of manifest.flow.triggers) {
      const deviceArg = trigger.args.find(arg => arg.type === 'device');
      expect(deviceArg).toEqual({
        type: 'device',
        name: 'device',
        filter: 'driver_id=garagedoor',
      });
    }
  });

  test('the set_state action offers exactly the states the device accepts', () => {
    const action = manifest.flow.actions.find(a => a.id === 'set_state');
    expect(action).toBeDefined();

    const stateArg = action.args.find(arg => arg.name === 'state');
    expect(stateArg.type).toBe('dropdown');
    expect(stateArg.values.map(v => v.id)).toEqual(STATES);

    const deviceArg = action.args.find(arg => arg.type === 'device');
    expect(deviceArg.filter).toBe('driver_id=garagedoor');
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
});
