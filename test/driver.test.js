'use strict';

const { createDriver } = require('./helpers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('VirtualGarageDoorDriver', () => {
  test('registers the set_state action card and routes it to the device', async () => {
    const driver = createDriver();
    await driver.onInit();

    expect(driver.homey.flow.getActionCard).toHaveBeenCalledWith('set_state');
    expect(driver._actionCard.registerRunListener).toHaveBeenCalledTimes(1);

    const runListener = driver._actionCard.registerRunListener.mock.calls[0][0];
    const device = { setReportedState: jest.fn().mockResolvedValue(undefined) };
    await runListener({ device, state: 'closing' });

    expect(device.setReportedState).toHaveBeenCalledWith('closing');
  });

  test('pairing offers exactly one new virtual device with a unique id', async () => {
    const driver = createDriver();

    const first = await driver.onPairListDevices();
    const second = await driver.onPairListDevices();

    expect(first).toHaveLength(1);
    expect(first[0].name).toBe('i18n:pair.defaultName');
    expect(first[0].data.id).toMatch(UUID_RE);
    expect(second[0].data.id).toMatch(UUID_RE);
    expect(second[0].data.id).not.toBe(first[0].data.id);
  });
});
