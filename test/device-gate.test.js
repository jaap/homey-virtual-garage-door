'use strict';

const {
  createDevice, createGateDevice, requestViaCapability, fireTravelTimer, pendingTimers,
} = require('./helpers');

const flush = () => new Promise(resolve => setImmediate(resolve));

const pulseCount = control => control.setCapabilityValue.mock.calls.length;

describe('VirtualGarageDoorDevice — auto-closing gate', () => {
  test('initializes CLOSED (a restart outlives the cycle), with the timing summary', async () => {
    const { device, api } = createGateDevice({ store: { reportedState: 'open' } });
    await device.onInit();

    expect(device._caps.garagedoor_state).toBe('closed');
    expect(device._caps.garagedoor_closed).toBe(true);
    expect(api.devices.on).toHaveBeenCalledWith('device.delete', expect.any(Function));
    expect(device._settings.managed_devices_summary).toBe('Gate Relay · 3/3/1s');
    expect(pendingTimers(device)).toHaveLength(0);
  });

  test('an open request pulses and starts the simulated cycle', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();

    await device.request('open');

    expect(control.setCapabilityValue).toHaveBeenCalledWith({ capabilityId: 'onoff', value: true });
    expect(device._caps.garagedoor_state).toBe('opening');
    expect(device._caps.garagedoor_closed).toBe(false);
    expect(pendingTimers(device)).toHaveLength(1);
    expect(pendingTimers(device)[0].ms).toBe(3000);
    expect(device._triggered.map(t => t.id)).toEqual(['open_requested']);
  });

  test('a capability open request resolves cleanly — no error toast for a gate trigger', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();

    const result = await requestViaCapability(device, 'garagedoor_closed', false);

    expect(result).toEqual({ rejected: false });
    expect(pulseCount(control)).toBe(1);
    expect(device._caps.garagedoor_state).toBe('opening');
    expect(device._caps.garagedoor_closed).toBe(false); // committed value matches the projection
  });

  test('a close request is refused: the gate closes by itself', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();
    await device.request('open');

    const result = await requestViaCapability(device, 'garagedoor_closed', true);

    expect(result).toEqual({ rejected: true, message: 'i18n:request.gate_auto_close' });
    expect(pulseCount(control)).toBe(1); // no extra pulse
    await expect(device.request('close')).rejects.toThrow('i18n:request.gate_auto_close');
  });

  test('the simulated cycle runs opening (3s) → open (3s) → closing (1s) → closed', async () => {
    const { device } = createGateDevice();
    await device.onInit();
    await device.request('open');

    fireTravelTimer(device);
    await flush();
    expect(device._caps.garagedoor_state).toBe('open');
    expect(pendingTimers(device)[0].ms).toBe(3000);

    fireTravelTimer(device);
    await flush();
    expect(device._caps.garagedoor_state).toBe('closing');
    expect(pendingTimers(device)[0].ms).toBe(1000);

    fireTravelTimer(device);
    await flush();
    expect(device._caps.garagedoor_state).toBe('closed');
    expect(device._caps.garagedoor_closed).toBe(true);
    expect(pendingTimers(device)).toHaveLength(0);
  });

  test('a kick while open re-pulses and restarts the hold', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();
    await device.request('open');
    fireTravelTimer(device);
    await flush();
    expect(device._caps.garagedoor_state).toBe('open');

    await device.request('open');

    expect(pulseCount(control)).toBe(2);
    expect(device._caps.garagedoor_state).toBe('open');
    expect(pendingTimers(device)).toHaveLength(1);
    expect(pendingTimers(device)[0].ms).toBe(3000); // fresh hold window
  });

  test('a kick while closing reverses the simulation back to opening', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();
    await device.request('open');
    fireTravelTimer(device); // open
    await flush();
    fireTravelTimer(device); // closing
    await flush();
    expect(device._caps.garagedoor_state).toBe('closing');

    await device.request('open');

    expect(pulseCount(control)).toBe(2);
    expect(device._caps.garagedoor_state).toBe('opening');
    expect(pendingTimers(device)[0].ms).toBe(3000);
  });

  test('the button capability is an always-available kick', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();

    await device._listeners.button(true, {});

    expect(pulseCount(control)).toBe(1);
    expect(device._caps.garagedoor_state).toBe('opening');
    expect(device._triggered.map(t => t.id)).toEqual(['open_requested']);
  });

  test('a failing control device surfaces an error; the simulation still settles closed', async () => {
    const { device, control } = createGateDevice();
    await device.onInit();
    control.setCapabilityValue.mockRejectedValue(new Error('offline'));

    await expect(device.request('open')).rejects.toThrow('i18n:request.control_failed');
    expect(device._caps.garagedoor_state).toBe('opening');

    fireTravelTimer(device);
    await flush();
    fireTravelTimer(device);
    await flush();
    fireTravelTimer(device);
    await flush();
    expect(device._caps.garagedoor_state).toBe('closed');
  });

  test('gate mode without a configured control device warns and stays flow-like', async () => {
    const device = createDevice({ type: 'gate', store: { reportedState: 'open' } });
    await device.onInit();

    expect(device.setWarning).toHaveBeenCalledWith('i18n:warning.not_configured');
    expect(device._caps.garagedoor_state).toBe('open'); // flow-style restore kept
  });

  test('the Report-state Flow card overrides the simulation and clears the timer', async () => {
    const { device } = createGateDevice();
    await device.onInit();
    await device.request('open');
    expect(pendingTimers(device)).toHaveLength(1);

    await device.setReportedState('closed');

    expect(device._caps.garagedoor_state).toBe('closed');
    expect(pendingTimers(device)).toHaveLength(0);
  });
});
