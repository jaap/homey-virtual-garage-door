'use strict';

/**
 * Consistency checks between the generated app manifest, the compose
 * sources, the package metadata and the constants used by the app code.
 * These catch drift that `homey app validate` cannot see, such as the Flow
 * dropdown offering a state the device implementation does not accept.
 */

const fs = require('fs');
const path = require('path');

const VirtualDoorDevice = require('../lib/virtual-door-device');

const ROOT = path.join(__dirname, '..');
const manifest = require('../app.json');
const composeApp = require('../.homeycompose/app.json');
const composeCapability = require('../.homeycompose/capabilities/garagedoor_state.json');
const pkg = require('../package.json');

const { STATES } = VirtualDoorDevice;
const DRIVER_IDS = ['flow-door', 'gate', 'managed-door'];
const DEVICE_FILTER = 'driver_id=flow-door|managed-door|gate';

const driverById = id => manifest.drivers.find(driver => driver.id === id);

describe('app manifest', () => {
  test('identity and platform', () => {
    expect(manifest.id).toBe('com.jaap.virtualgaragedoor');
    expect(manifest.sdk).toBe(3);
    expect(manifest.platforms).toEqual(['local']);
    // Managed/gate devices and the presence check use the Homey Web API
    expect(manifest.permissions).toEqual(['homey:manager:api']);
  });

  test('versions in app.json, compose and package.json agree', () => {
    expect(manifest.version).toBe(composeApp.version);
    expect(manifest.version).toBe(pkg.version);
  });

  test('App Store description files exist', () => {
    // `homey app publish` requires README.txt (the store page text), but
    // `homey app validate --level publish` does not check for it.
    for (const file of ['README.txt', 'README.nl.txt']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text.trim().length).toBeGreaterThan(100);
    }
  });

  test('exactly the three driver types exist, all garagedoor class', () => {
    expect(manifest.drivers.map(driver => driver.id).sort()).toEqual(DRIVER_IDS);
    for (const driver of manifest.drivers) {
      expect(driver.class).toBe('garagedoor');
    }
  });

  test('capabilities per driver: doors are plain, the gate adds its kick button', () => {
    expect(driverById('flow-door').capabilities).toEqual(['garagedoor_closed', 'garagedoor_state']);
    expect(driverById('managed-door').capabilities).toEqual(['garagedoor_closed', 'garagedoor_state']);
    expect(driverById('gate').capabilities).toEqual(['garagedoor_closed', 'garagedoor_state', 'button']);
    expect(driverById('gate').capabilitiesOptions.button.title.en).toBe('Open / keep open');
  });

  test('pairing flows per driver, with every custom view present on disk', () => {
    expect(driverById('flow-door').pair.map(view => view.id)).toEqual(['name', 'list_devices', 'add_devices']);
    expect(driverById('managed-door').pair.map(view => view.id)).toEqual(['managed_config', 'list_devices', 'add_devices']);
    expect(driverById('gate').pair.map(view => view.id)).toEqual(['gate_config', 'list_devices', 'add_devices']);
    expect(driverById('managed-door').repair.map(view => view.id)).toEqual(['managed_config']);
    expect(driverById('gate').repair.map(view => view.id)).toEqual(['gate_config']);
    expect(driverById('flow-door').repair).toBeUndefined();

    for (const file of [
      'drivers/flow-door/pair/name.html',
      'drivers/managed-door/pair/managed_config.html',
      'drivers/managed-door/repair/managed_config.html',
      'drivers/gate/pair/gate_config.html',
      'drivers/gate/repair/gate_config.html',
    ]) {
      expect(fs.existsSync(path.join(ROOT, file))).toBe(true);
    }
  });

  test('settings per driver contain exactly the relevant knobs', () => {
    const settingIds = driver => driver.settings.flatMap(group => group.children.map(child => child.id)).sort();

    expect(settingIds(driverById('flow-door'))).toEqual(['open_restriction']);
    expect(settingIds(driverById('managed-door'))).toEqual([
      'closed_sensor_meaning', 'managed_devices_summary', 'open_restriction', 'open_sensor_meaning', 'travel_time',
    ].sort());
    expect(settingIds(driverById('gate'))).toEqual([
      'gate_closing_time', 'gate_hold_time', 'gate_opening_time', 'managed_devices_summary', 'open_restriction',
    ].sort());

    // no driver exposes a mode setting anymore — the driver type is the mode
    for (const driver of manifest.drivers) {
      expect(settingIds(driver)).not.toContain('mode');
    }
  });

  test('the open restriction dropdown offers exactly the policies the code implements', () => {
    for (const id of DRIVER_IDS) {
      const setting = driverById(id).settings
        .flatMap(group => group.children)
        .find(child => child.id === 'open_restriction');
      expect(setting.type).toBe('dropdown');
      expect(setting.values.map(value => value.id)).toEqual(Object.values(VirtualDoorDevice.OPEN_RESTRICTIONS));
      expect(setting.value).toBe(VirtualDoorDevice.OPEN_RESTRICTIONS.ALWAYS);
    }
  });

  test('flow cards are shared across all three drivers', () => {
    const triggers = manifest.flow.triggers.map(t => t.id).sort();
    expect(triggers).toEqual(['close_requested', 'garagedoor_state_changed', 'movement_failed', 'open_requested']);

    const actions = manifest.flow.actions.map(a => a.id).sort();
    expect(actions).toEqual(['request_close', 'request_open', 'set_state']);

    for (const card of [...manifest.flow.triggers, ...manifest.flow.actions]) {
      const deviceArg = card.args.find(arg => arg.type === 'device');
      expect(deviceArg).toEqual({
        type: 'device',
        name: 'device',
        filter: DEVICE_FILTER,
      });
    }
  });

  test('the movement-failed trigger exposes the direction as a token', () => {
    const trigger = manifest.flow.triggers.find(t => t.id === 'movement_failed');
    expect(trigger.tokens).toHaveLength(1);
    expect(trigger.tokens[0].name).toBe('direction');
    expect(trigger.tokens[0].type).toBe('string');
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
    expect(capability).toEqual(composeCapability);
  });

  test('every referenced asset exists with the sizes Homey requires', () => {
    const assets = [
      ...Object.values(manifest.images),
      manifest.capabilities.garagedoor_state.icon,
      '/assets/icon.svg',
    ];
    for (const driver of manifest.drivers) {
      assets.push(...Object.values(driver.images));
      assets.push(`/drivers/${driver.id}/assets/icon.svg`);
    }
    for (const assetPath of assets) {
      expect(fs.existsSync(path.join(ROOT, assetPath.replace(/^\//, '')))).toBe(true);
    }

    const expectSize = (file, width, height) => {
      const buffer = fs.readFileSync(path.join(ROOT, file.replace(/^\//, '')));
      expect(buffer.readUInt32BE(16)).toBe(width);
      expect(buffer.readUInt32BE(20)).toBe(height);
    };
    expectSize(manifest.images.small, 250, 175);
    expectSize(manifest.images.large, 500, 350);
    expectSize(manifest.images.xlarge, 1000, 700);
    for (const driver of manifest.drivers) {
      expectSize(driver.images.small, 75, 75);
      expectSize(driver.images.large, 500, 500);
      expectSize(driver.images.xlarge, 1000, 1000);
    }
  });
});
