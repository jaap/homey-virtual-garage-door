'use strict';

const {
  createDevice, createApi, createManagedDevice, requestViaCapability, fireTravelTimer, pendingTimers,
} = require('./helpers');

const flush = () => new Promise(resolve => setImmediate(resolve));

const pulseCount = control => control.setCapabilityValue.mock.calls.length;

describe('VirtualGarageDoorDevice — Managed mode', () => {
  describe('initialization', () => {
    test('door at the closed endpoint initializes CLOSED and watches for deleted devices', async () => {
      const { device, api } = createManagedDevice({ closedRaw: false });
      await device.onInit();

      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._caps.garagedoor_closed).toBe(true);
      expect(api.devices.on).toHaveBeenCalledWith('device.delete', expect.any(Function));
      expect(device._settings.managed_devices_summary).toBe('Garage Relay · Closed Sensor');
      expect(device._triggered).toEqual([]);
    });

    test('one sensor, not at the closed endpoint, previously open → OPEN', async () => {
      const { device } = createManagedDevice({ closedRaw: true, store: { reportedState: 'open' } });
      await device.onInit();
      expect(device._caps.garagedoor_state).toBe('open');
    });

    test('restart mid-travel with two sensors → STOPPED, no pulse, no timer', async () => {
      const { device, control } = createManagedDevice({
        withOpenSensor: true,
        closedRaw: true, // contact open: not at closed endpoint
        openRaw: true, // contact open: not at open endpoint
        store: { reportedState: 'opening' },
      });
      await device.onInit();

      expect(device._caps.garagedoor_state).toBe('stopped');
      expect(pulseCount(control)).toBe(0);
      expect(pendingTimers(device)).toHaveLength(0);
    });

    test('inverted closed-sensor meaning flips the endpoint interpretation', async () => {
      const { device } = createManagedDevice({
        closedRaw: true,
        settings: { closed_sensor_meaning: 'inverted' },
      });
      await device.onInit();
      expect(device._caps.garagedoor_state).toBe('closed');
    });

    test('managed mode without configured devices warns and keeps the last state', async () => {
      const device = createDevice({ type: 'managed', store: { reportedState: 'open' } });
      await device.onInit();

      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.not_configured');
      expect(device._caps.garagedoor_state).toBe('open');
    });

    test('a missing referenced device warns instead of crashing', async () => {
      const { device, api } = createManagedDevice();
      api.devices.getDevice.mockImplementation(async ({ id }) => {
        throw new Error(`device ${id} not found`);
      });
      await device.onInit();

      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.missing_device');
      expect(device._caps.garagedoor_state).toBe('closed'); // flow-style fallback restore
    });
  });

  describe('requests', () => {
    test('open request from CLOSED pulses the control device and starts the travel timer', async () => {
      const { device, control } = createManagedDevice();
      await device.onInit();

      await device.request('open');

      expect(control.setCapabilityValue).toHaveBeenCalledWith({ capabilityId: 'onoff', value: true });
      expect(device._caps.garagedoor_state).toBe('opening');
      expect(device._caps.garagedoor_closed).toBe(true); // endpoint-hold until (presumed) open
      expect(pendingTimers(device)).toHaveLength(1);
      expect(pendingTimers(device)[0].ms).toBe(18000);
      expect(device._triggered.map(t => t.id)).toEqual(['open_requested']);
    });

    test('a capability request (tile/HomeKit) acts, then rejects with the movement message', async () => {
      const { device, control } = createManagedDevice();
      await device.onInit();

      const result = await requestViaCapability(device, 'garagedoor_closed', false);

      expect(result).toEqual({ rejected: true, message: 'i18n:request.opening' });
      expect(pulseCount(control)).toBe(1);
      expect(device._caps.garagedoor_state).toBe('opening');
    });

    test('requests while moving are refused without another pulse', async () => {
      const { device, control } = createManagedDevice();
      await device.onInit();
      await device.request('open');

      await expect(device.request('close')).rejects.toThrow('i18n:request.already_moving');
      await expect(device.request('open')).rejects.toThrow('i18n:request.already_moving');
      expect(pulseCount(control)).toBe(1);
    });

    test('a refused capability open schedules the cache re-assert; an accepted one does not', async () => {
      const { device } = createManagedDevice();
      await device.onInit();

      await requestViaCapability(device, 'garagedoor_closed', false); // accepted (opening)
      expect(device._timers.filter(t => !t.cleared && t.ms === 1500)).toHaveLength(0);

      await requestViaCapability(device, 'garagedoor_closed', false); // refused: already moving
      expect(device._timers.filter(t => !t.cleared && t.ms === 1500)).toHaveLength(1);
    });

    test('same-state requests are refused', async () => {
      const { device, control } = createManagedDevice();
      await device.onInit();

      await expect(device.request('close')).rejects.toThrow('i18n:request.already_closed');
      expect(pulseCount(control)).toBe(0);
    });

    test('a failing control device surfaces an error, then the timeout settles back to CLOSED', async () => {
      const { device, control } = createManagedDevice();
      await device.onInit();
      control.setCapabilityValue.mockRejectedValue(new Error('offline'));

      await expect(device.request('open')).rejects.toThrow('i18n:request.control_failed');
      expect(device._caps.garagedoor_state).toBe('opening');

      fireTravelTimer(device);
      await flush();
      // the closed sensor never released: the door did not move, so the
      // machine settles honestly on CLOSED and reports the failed movement
      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._caps.garagedoor_closed).toBe(true);
      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.not_reached_open');
      expect(device._triggered.find(t => t.id === 'movement_failed').tokens).toEqual({ direction: 'opening' });
    });
  });

  describe('movement tracked by sensors', () => {
    test('full cycle with one sensor: open (inferred) then close (sensor-confirmed)', async () => {
      const { device, control, closedSensor } = createManagedDevice();
      await device.onInit();

      await device.request('open');
      closedSensor.push('alarm_contact', true); // left the closed endpoint
      await flush();
      expect(device._caps.garagedoor_state).toBe('opening');

      fireTravelTimer(device);
      await flush();
      expect(device._caps.garagedoor_state).toBe('open'); // inferred from travel time

      await device.request('close');
      expect(pulseCount(control)).toBe(2);
      expect(device._caps.garagedoor_state).toBe('closing');

      closedSensor.push('alarm_contact', false); // reached the closed endpoint
      await flush();
      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._caps.garagedoor_closed).toBe(true);
      expect(pendingTimers(device)).toHaveLength(0);
    });

    test('full cycle with two sensors: endpoints confirm, timer never claims', async () => {
      const { device, closedSensor, openSensor } = createManagedDevice({ withOpenSensor: true });
      await device.onInit();

      await device.request('open');
      closedSensor.push('alarm_contact', true);
      await flush();
      expect(device._caps.garagedoor_state).toBe('opening');

      openSensor.push('alarm_contact', false); // reached the open endpoint
      await flush();
      expect(device._caps.garagedoor_state).toBe('open');
      expect(pendingTimers(device)).toHaveLength(0);
    });

    test('two sensors: travel timeout while opening → STOPPED + warning + failure trigger', async () => {
      const { device, closedSensor } = createManagedDevice({ withOpenSensor: true });
      await device.onInit();

      await device.request('open');
      closedSensor.push('alarm_contact', true); // door left the closed endpoint…
      await flush();
      fireTravelTimer(device); // …but never reached the open endpoint
      await flush();

      expect(device._caps.garagedoor_state).toBe('stopped');
      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.not_reached_open');
      const failed = device._triggered.find(t => t.id === 'movement_failed');
      expect(failed.tokens).toEqual({ direction: 'opening' });
    });

    test('closing timeout never claims CLOSED, with one or two sensors', async () => {
      const { device, closedSensor } = createManagedDevice({ closedRaw: true, store: { reportedState: 'open' } });
      await device.onInit();

      await device.request('close');
      fireTravelTimer(device);
      await flush();

      expect(device._caps.garagedoor_state).toBe('stopped');
      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.not_reached_closed');

      closedSensor.push('alarm_contact', false); // the sensor stays authoritative
      await flush();
      expect(device._caps.garagedoor_state).toBe('closed');
    });
  });

  describe('manual / external operation', () => {
    test('leaving the closed endpoint without a command → OPENING, no pulse', async () => {
      const { device, control, closedSensor } = createManagedDevice();
      await device.onInit();

      closedSensor.push('alarm_contact', true);
      await flush();

      expect(device._caps.garagedoor_state).toBe('opening');
      expect(pulseCount(control)).toBe(0);
      expect(pendingTimers(device)).toHaveLength(1); // timeout still applies
    });

    test('two sensors: manual open completes at the open endpoint', async () => {
      const { device, closedSensor, openSensor } = createManagedDevice({ withOpenSensor: true });
      await device.onInit();

      closedSensor.push('alarm_contact', true);
      await flush();
      openSensor.push('alarm_contact', false);
      await flush();

      expect(device._caps.garagedoor_state).toBe('open');
    });
  });

  describe('conflicting sensors', () => {
    test('both endpoints active → warning, no pulse, requests refused', async () => {
      const { device, control, openSensor } = createManagedDevice({ withOpenSensor: true });
      await device.onInit();

      openSensor.push('alarm_contact', false); // open endpoint while still closed
      await flush();

      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.sensor_conflict');
      expect(device._caps.garagedoor_state).toBe('closed'); // phase kept
      expect(pulseCount(control)).toBe(0);
      await expect(device.request('open')).rejects.toThrow('i18n:request.sensor_conflict');
    });
  });

  describe('escape hatch and lifecycle', () => {
    test('the Report-state Flow card overrides the machine and clears the timer', async () => {
      const { device } = createManagedDevice();
      await device.onInit();
      await device.request('open');
      expect(pendingTimers(device)).toHaveLength(1);

      await device.setReportedState('open');

      expect(device._caps.garagedoor_state).toBe('open');
      expect(pendingTimers(device)).toHaveLength(0);
    });

    test('deleting a referenced device raises a warning', async () => {
      const { device, api } = createManagedDevice();
      await device.onInit();

      const onDelete = api.devices.on.mock.calls.find(c => c[0] === 'device.delete')[1];
      onDelete({ id: 'unrelated' });
      expect(device.setWarning).not.toHaveBeenCalled();
      onDelete({ id: 'cs' });
      expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.missing_device');
    });

    test('teardown destroys sensor subscriptions and detaches the delete watcher', async () => {
      const { device, api, closedSensor } = createManagedDevice();
      await device.onInit();
      await device.request('open');

      await device.onDeleted();

      expect(closedSensor._instances[0].destroy).toHaveBeenCalled();
      expect(api.devices.off).toHaveBeenCalledWith('device.delete', expect.any(Function));
      expect(pendingTimers(device)).toHaveLength(0);
    });
  });
});
