'use strict';

const { createDriver } = require('./helpers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  ])('the %s card routes to device.requestState(%s)', async (cardId, kind) => {
    const driver = createDriver();
    await driver.onInit();

    const runListener = driver._actionCards[cardId].registerRunListener.mock.calls[0][0];
    const device = { requestState: jest.fn() };
    await runListener({ device });

    expect(device.requestState).toHaveBeenCalledWith(kind);
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
