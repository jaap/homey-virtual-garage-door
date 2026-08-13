'use strict';

const VirtualGarageDoorDevice = require('../drivers/garagedoor/device');
const VirtualGarageDoorDriver = require('../drivers/garagedoor/driver');

/**
 * Build a VirtualGarageDoorDevice with the Homey SDK surface it uses mocked
 * out. Capability values live in `device._caps`, the device store in
 * `device._store`, settings in `device._settings`, registered capability
 * listeners in `device._listeners`, fired Flow triggers in
 * `device._triggered` as `{ id, device, tokens }`, and armed timers in
 * `device._timers` as `{ id, fn, ms, cleared }`.
 *
 * The device is returned uninitialized; tests call `await device.onInit()`.
 */
function createDevice({ store = {}, capabilities = {}, settings = {}, api = null } = {}) {
  const device = new VirtualGarageDoorDevice();

  device._store = { ...store };
  device._caps = { garagedoor_closed: null, garagedoor_state: null, ...capabilities };
  device._settings = {
    mode: 'flow',
    travel_time: 18,
    closed_sensor_meaning: 'default',
    open_sensor_meaning: 'default',
    ...settings,
  };
  device._listeners = {};
  device._triggered = [];
  device._timers = [];

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
  device.getSetting = jest.fn(key => (key in device._settings ? device._settings[key] : null));
  device.setSettings = jest.fn(async values => {
    Object.assign(device._settings, values);
  });
  device.setWarning = jest.fn(async () => {});
  device.unsetWarning = jest.fn(async () => {});
  device.registerCapabilityListener = jest.fn((id, listener) => {
    device._listeners[id] = listener;
  });

  let timerId = 0;
  device.homey = {
    __: jest.fn(key => `i18n:${key}`),
    setTimeout: jest.fn((fn, ms) => {
      timerId += 1;
      device._timers.push({ id: timerId, fn, ms, cleared: false });
      return timerId;
    }),
    clearTimeout: jest.fn(id => {
      const timer = device._timers.find(t => t.id === id);
      if (timer) timer.cleared = true;
    }),
    flow: {
      getDeviceTriggerCard: jest.fn(id => ({
        trigger: jest.fn(async (triggeredDevice, tokens) => {
          device._triggered.push({ id, device: triggeredDevice, tokens });
        }),
      })),
    },
    app: {
      getApi: jest.fn(async () => {
        if (!api) throw new Error('no api in this test');
        return api;
      }),
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

/** Fire the most recently armed, uncleared travel timer. */
function fireTravelTimer(device) {
  const timer = [...device._timers].reverse().find(t => !t.cleared);
  if (!timer) throw new Error('no armed timer');
  timer.cleared = true;
  timer.fn();
}

function pendingTimers(device) {
  return device._timers.filter(t => !t.cleared);
}

/**
 * Fake Homey Web API device as returned by `api.devices.getDevice()`.
 * Sensor pushes go through `fake.push(capabilityId, rawValue)`.
 */
function createApiDevice({ id, name = id, capabilities = {} }) {
  const fake = {
    id,
    name,
    zoneName: 'Garage',
    driverId: `homey:app:com.example.other:${id}`,
    capabilitiesObj: {},
    _listeners: {},
    _instances: [],
  };
  for (const [capabilityId, spec] of Object.entries(capabilities)) {
    fake.capabilitiesObj[capabilityId] = { type: 'boolean', getable: true, setable: true, value: null, ...spec };
  }
  fake.makeCapabilityInstance = jest.fn((capabilityId, listener) => {
    fake._listeners[capabilityId] = listener;
    const instance = {
      get value() {
        return fake.capabilitiesObj[capabilityId] ? fake.capabilitiesObj[capabilityId].value : null;
      },
      destroy: jest.fn(),
    };
    fake._instances.push(instance);
    return instance;
  });
  fake.setCapabilityValue = jest.fn(async () => {});
  fake.push = (capabilityId, rawValue) => {
    fake.capabilitiesObj[capabilityId].value = rawValue;
    if (fake._listeners[capabilityId]) fake._listeners[capabilityId](rawValue);
  };
  return fake;
}

/** Fake Homey Web API with a set of devices keyed by id and Homey users. */
function createApi(devicesById, { users = { owner: { id: 'owner', present: true } } } = {}) {
  return {
    devices: {
      getDevice: jest.fn(async ({ id }) => {
        if (!devicesById[id]) throw new Error(`device ${id} not found`);
        return devicesById[id];
      }),
      getDevices: jest.fn(async () => devicesById),
      on: jest.fn(),
      off: jest.fn(),
    },
    users: {
      getUsers: jest.fn(async () => users),
    },
  };
}

/**
 * A ready-to-init Managed mode device: control relay `ctrl` (onoff),
 * closed sensor `cs` (alarm_contact) and, when `withOpenSensor`, open
 * sensor `os` (alarm_contact). With the default meaning, alarm_contact
 * raw `false` (contact closed) means the door is at that endpoint.
 */
function createManagedDevice({
  withOpenSensor = false,
  closedRaw = false, // door at closed endpoint
  openRaw = true, // door not at open endpoint
  store = {},
  settings = {},
} = {}) {
  const control = createApiDevice({ id: 'ctrl', name: 'Garage Relay', capabilities: { onoff: { value: false } } });
  const closedSensor = createApiDevice({ id: 'cs', name: 'Closed Sensor', capabilities: { alarm_contact: { value: closedRaw, setable: false } } });
  const openSensor = createApiDevice({ id: 'os', name: 'Open Sensor', capabilities: { alarm_contact: { value: openRaw, setable: false } } });

  const api = createApi(withOpenSensor ? { ctrl: control, cs: closedSensor, os: openSensor } : { ctrl: control, cs: closedSensor });

  const device = createDevice({
    api,
    settings: { mode: 'managed', ...settings },
    store: {
      controlDevice: { id: 'ctrl', capability: 'onoff' },
      closedSensor: { id: 'cs', capability: 'alarm_contact' },
      openSensor: withOpenSensor ? { id: 'os', capability: 'alarm_contact' } : null,
      ...store,
    },
  });

  return { device, api, control, closedSensor, openSensor };
}

/**
 * A ready-to-init auto-closing gate device: control relay `ctrl` and the
 * user's quick-reset timing trick (3 s opening / 3 s open / 1 s closing).
 */
function createGateDevice({ settings = {}, store = {} } = {}) {
  const control = createApiDevice({ id: 'ctrl', name: 'Gate Relay', capabilities: { onoff: { value: false } } });
  const api = createApi({ ctrl: control });

  const device = createDevice({
    api,
    capabilities: { button: null },
    settings: {
      mode: 'gate', gate_opening_time: 3, gate_hold_time: 3, gate_closing_time: 1, ...settings,
    },
    store: {
      controlDevice: { id: 'ctrl', capability: 'onoff' }, closedSensor: null, openSensor: null, ...store,
    },
  });

  return { device, api, control };
}

/**
 * Build a VirtualGarageDoorDriver with a mocked Homey SDK surface. Action
 * card mocks are exposed per card id via `driver._actionCards`.
 */
function createDriver({ api = null } = {}) {
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
    app: {
      getApi: jest.fn(async () => {
        if (!api) throw new Error('no api in this test');
        return api;
      }),
    },
  };

  return driver;
}

/** Fake PairSession collecting handlers in `session.handlers`. */
function createPairSession() {
  const session = {
    handlers: {},
    setHandler: jest.fn((event, handler) => {
      session.handlers[event] = handler;
      return session;
    }),
  };
  return session;
}

module.exports = {
  createDevice,
  createDriver,
  createApi,
  createApiDevice,
  createManagedDevice,
  createGateDevice,
  createPairSession,
  requestViaCapability,
  fireTravelTimer,
  pendingTimers,
};
