'use strict';

const VirtualGarageDoorDevice = require('../drivers/garagedoor/device');
const VirtualGarageDoorDriver = require('../drivers/garagedoor/driver');

/**
 * Build a VirtualGarageDoorDevice with the Homey SDK surface it uses mocked
 * out. Capability values live in `device._caps`, the device store in
 * `device._store`, registered capability listeners in `device._listeners`
 * and every fired Flow trigger in `device._triggered` as `{ id, device }`.
 *
 * The device is returned uninitialized; tests call `await device.onInit()`.
 */
function createDevice({ store = {}, capabilities = {} } = {}) {
  const device = new VirtualGarageDoorDevice();

  device._store = { ...store };
  device._caps = { garagedoor_closed: null, garagedoor_state: null, ...capabilities };
  device._listeners = {};
  device._triggered = [];

  device.log = jest.fn();
  device.error = jest.fn();

  device.hasCapability = jest.fn(id => Object.prototype.hasOwnProperty.call(device._caps, id));
  device.addCapability = jest.fn(async id => {
    device._caps[id] = null;
  });
  device.getCapabilityValue = jest.fn(id => device._caps[id]);
  device.setCapabilityValue = jest.fn(async (id, value) => {
    device._caps[id] = value;
  });
  device.getStoreValue = jest.fn(key => (key in device._store ? device._store[key] : null));
  device.setStoreValue = jest.fn(async (key, value) => {
    device._store[key] = value;
  });
  device.registerCapabilityListener = jest.fn((id, listener) => {
    device._listeners[id] = listener;
  });

  device.homey = {
    // Evaluated at call time, so Jest fake timers apply.
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    flow: {
      getDeviceTriggerCard: jest.fn(id => ({
        trigger: jest.fn(async triggeredDevice => {
          device._triggered.push({ id, device: triggeredDevice });
        }),
      })),
    },
  };

  return device;
}

/**
 * Simulate an external capability set request (Homey app UI, HomeKitty via
 * the Homey API, or a standard Flow action card): Homey Core invokes the
 * registered capability listener and, when it resolves, stores the requested
 * value as the capability value.
 */
async function externalSet(device, capabilityId, value) {
  await device._listeners[capabilityId](value, {});
  device._caps[capabilityId] = value; // Homey Core's optimistic update on resolve
}

/**
 * Build a VirtualGarageDoorDriver with a mocked Homey SDK surface. The
 * `set_state` action card mock is exposed as `driver._actionCard`.
 */
function createDriver() {
  const driver = new VirtualGarageDoorDriver();

  driver.log = jest.fn();
  driver.error = jest.fn();

  const actionCard = { registerRunListener: jest.fn() };
  driver._actionCard = actionCard;
  driver.homey = {
    __: jest.fn(key => `i18n:${key}`),
    flow: {
      getActionCard: jest.fn(() => actionCard),
    },
  };

  return driver;
}

module.exports = { createDevice, createDriver, externalSet };
