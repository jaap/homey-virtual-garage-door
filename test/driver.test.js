'use strict';

const { createDriver, createApi, createApiDevice, createPairSession } = require('./helpers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const VALID_CONFIG = {
  controlDevice: { id: 'relay-1' },
  closedSensor: { id: 'sensor-1', capability: 'alarm_contact' },
  openSensor: null,
  closedSensorMeaning: 'default',
  openSensorMeaning: 'default',
  travelTime: 18,
};

describe('VirtualGarageDoorDriver', () => {
  test('registers run listeners for all three action cards', async () => {
    const driver = createDriver();
    await driver.onInit();

    for (const id of ['set_state', 'request_open', 'request_close']) {
      expect(driver.homey.flow.getActionCard).toHaveBeenCalledWith(id);
      expect(driver._actionCards[id].registerRunListener).toHaveBeenCalledTimes(1);
    }
  });

  test('the set_state card routes to device.setReportedState', async () => {
    const driver = createDriver();
    await driver.onInit();

    const runListener = driver._actionCards.set_state.registerRunListener.mock.calls[0][0];
    const device = { setReportedState: jest.fn().mockResolvedValue(undefined) };
    await runListener({ device, state: 'closing' });

    expect(device.setReportedState).toHaveBeenCalledWith('closing');
  });

  test.each([
    ['request_open', 'open'],
    ['request_close', 'close'],
  ])('the %s card routes to device.request(%s)', async (cardId, direction) => {
    const driver = createDriver();
    await driver.onInit();

    const runListener = driver._actionCards[cardId].registerRunListener.mock.calls[0][0];
    const device = { request: jest.fn().mockResolvedValue(undefined) };
    await runListener({ device });

    expect(device.request).toHaveBeenCalledWith(direction);
  });

  describe('pairing', () => {
    test('without managed configuration, list_devices offers a plain flow-controlled device', async () => {
      const driver = createDriver();
      const session = createPairSession();
      await driver.onPair(session);

      const [device] = await session.handlers.list_devices();
      expect(device.name).toBe('i18n:pair.defaultName');
      expect(device.data.id).toMatch(UUID_RE);
      expect(device.settings).toBeUndefined();
      expect(device.store).toBeUndefined();
    });

    test('with managed configuration, the new device carries settings and store references', async () => {
      const driver = createDriver();
      const session = createPairSession();
      await driver.onPair(session);

      await session.handlers.set_managed_config(VALID_CONFIG);
      const [device] = await session.handlers.list_devices();

      expect(device.settings).toEqual({
        mode: 'managed',
        travel_time: 18,
        closed_sensor_meaning: 'default',
        open_sensor_meaning: 'default',
      });
      expect(device.store).toEqual({
        controlDevice: { id: 'relay-1', capability: 'onoff' },
        closedSensor: { id: 'sensor-1', capability: 'alarm_contact' },
        openSensor: null,
      });
    });

    test('every pairing session mints a unique device id', async () => {
      const driver = createDriver();
      const session = createPairSession();
      await driver.onPair(session);

      const [first] = await session.handlers.list_devices();
      const [second] = await session.handlers.list_devices();
      expect(first.data.id).not.toBe(second.data.id);
    });
  });

  describe('getPairData', () => {
    test('collects onoff controls and boolean sensor capabilities, excluding own devices', async () => {
      const relay = createApiDevice({ id: 'relay-1', name: 'Garage Relay', capabilities: { onoff: { value: false } } });
      const sensor = createApiDevice({
        id: 'sensor-1',
        name: 'Aqara Sensor',
        capabilities: {
          alarm_contact: { value: false, setable: false, title: 'Contact alarm' },
          measure_battery: { value: 80, type: 'number' },
        },
      });
      const ownDoor = createApiDevice({ id: 'own-1', name: 'Virtual Garage Door', capabilities: { garagedoor_closed: { value: true } } });
      ownDoor.driverId = 'homey:app:com.jaap.virtualgaragedoor:garagedoor';

      const driver = createDriver({ api: createApi({ 'relay-1': relay, 'sensor-1': sensor, 'own-1': ownDoor }) });
      const data = await driver.getPairData();

      expect(data.controls).toEqual([
        { deviceId: 'relay-1', name: 'Garage Relay', zone: 'Garage' },
      ]);
      expect(data.sensors).toEqual([
        {
          deviceId: 'sensor-1', deviceName: 'Aqara Sensor', zone: 'Garage', capabilityId: 'alarm_contact', capabilityTitle: 'Contact alarm',
        },
        {
          deviceId: 'relay-1', deviceName: 'Garage Relay', zone: 'Garage', capabilityId: 'onoff', capabilityTitle: 'onoff',
        },
      ]);
    });
  });

  describe('validateManagedConfig', () => {
    test('accepts a valid configuration and normalizes it', () => {
      const driver = createDriver();
      const result = driver.validateManagedConfig({ ...VALID_CONFIG, travelTime: '18', closedSensorMeaning: 'weird' });
      expect(result.travelTime).toBe(18);
      expect(result.closedSensorMeaning).toBe('default');
      expect(result.controlDevice).toEqual({ id: 'relay-1', capability: 'onoff' });
    });

    test('rejects missing control device, missing closed sensor and bad travel times', () => {
      const driver = createDriver();
      expect(() => driver.validateManagedConfig({ ...VALID_CONFIG, controlDevice: null })).toThrow(/control device/);
      expect(() => driver.validateManagedConfig({ ...VALID_CONFIG, closedSensor: null })).toThrow(/closed sensor/);
      expect(() => driver.validateManagedConfig({ ...VALID_CONFIG, travelTime: 3 })).toThrow(/Travel time/);
      expect(() => driver.validateManagedConfig({ ...VALID_CONFIG, travelTime: 900 })).toThrow(/Travel time/);
    });
  });

  describe('repair', () => {
    test('exposes the current configuration and applies a validated new one', async () => {
      const driver = createDriver();
      const session = createPairSession();
      const device = {
        getManagedConfig: jest.fn(() => ({ travelTime: 18 })),
        applyManagedConfig: jest.fn().mockResolvedValue(undefined),
      };
      await driver.onRepair(session, device);

      expect(await session.handlers.get_current_config()).toEqual({ travelTime: 18 });

      await session.handlers.set_managed_config(VALID_CONFIG);
      expect(device.applyManagedConfig).toHaveBeenCalledWith(expect.objectContaining({
        controlDevice: { id: 'relay-1', capability: 'onoff' },
        travelTime: 18,
      }));
    });
  });

  test('pairing offers a device named from i18n', async () => {
    const driver = createDriver();
    const session = createPairSession();
    await driver.onPair(session);
    const [device] = await session.handlers.list_devices();
    expect(device.name).toBe('i18n:pair.defaultName');
  });
});
