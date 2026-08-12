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
    __: jest.fn(key => `i18n:${key}`),
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
 * the Homey API, or a built-in capability Flow card): Homey Core invokes the
 * registered capability listener; when it resolves the requested value is
 * committed, when it rejects the value is left unchanged and the error is
 * shown to the requester. Returns `{ rejected, message }`.
 */
async function requestViaCapability(device, capabilityId, value) {
  try {
    await device._listeners[capabilityId](value, {});
  } catch (err) {
    return { rejected: true, message: err.message };
  }
  device._caps[capabilityId] = value; // Homey Core commits the value on resolve
  return { rejected: false };
}

/**
 * Build a VirtualGarageDoorDriver with a mocked Homey SDK surface. Action
 * card mocks are exposed per card id via `driver._actionCards`.
 */
function createDriver() {
  const driver = new VirtualGarageDoorDriver();

  driver.log = jest.fn();
  driver.error = jest.fn();

  const actionCards = {};
  driver._actionCards = actionCards;
  driver.homey = {
    __: jest.fn(key => `i18n:${key}`),
    flow: {
      getActionCard: jest.fn(id => {
        actionCards[id] = actionCards[id] || { registerRunListener: jest.fn() };
        return actionCards[id];
      }),
    },
  };

  return driver;
}

module.exports = { createDevice, createDriver, requestViaCapability };
