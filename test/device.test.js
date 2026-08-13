'use strict';

const VirtualGarageDoorDevice = require('../drivers/garagedoor/device');
const { createDevice, requestViaCapability } = require('./helpers');

const { STATES } = VirtualGarageDoorDevice;

describe('VirtualGarageDoorDevice', () => {
  describe('initialization', () => {
    test('a fresh device defaults to closed, without firing any trigger', async () => {
      const device = createDevice();
      await device.onInit();

      expect(device._caps.garagedoor_closed).toBe(true);
      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._store.reportedState).toBe('closed');
      expect(device._triggered).toEqual([]);
    });

    test('restores the last reported state from the store, even when capability values disagree', async () => {
      const device = createDevice({
        store: { reportedState: 'open' },
        capabilities: { garagedoor_closed: true, garagedoor_state: 'closed' },
      });
      await device.onInit();

      expect(device._caps.garagedoor_closed).toBe(false);
      expect(device._caps.garagedoor_state).toBe('open');
      expect(device._triggered).toEqual([]);
    });

    test('adds the garagedoor_state capability to devices from before it existed', async () => {
      const device = createDevice({ capabilities: { garagedoor_closed: false } });
      delete device._caps.garagedoor_state;
      await device.onInit();

      expect(device.addCapability).toHaveBeenCalledWith('garagedoor_state');
      expect(device._caps.garagedoor_state).toBe('open');
      expect(device._store.reportedState).toBe('open');
    });

    test('derives closed from a true garagedoor_closed value when the store is empty', async () => {
      const device = createDevice({ capabilities: { garagedoor_closed: true } });
      await device.onInit();

      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._store.reportedState).toBe('closed');
    });
  });

  describe('requests through the garagedoor_closed capability', () => {
    test('an open request fires the open_requested trigger for this device', async () => {
      const device = createDevice();
      await device.onInit();

      await requestViaCapability(device, 'garagedoor_closed', false);

      expect(device._triggered).toHaveLength(1);
      expect(device._triggered[0].id).toBe('open_requested');
      expect(device._triggered[0].device).toBe(device);
    });

    test('a close request fires the close_requested trigger', async () => {
      const device = createDevice();
      await device.onInit();
      await device.setReportedState('open');

      await requestViaCapability(device, 'garagedoor_closed', true);

      expect(device._triggered.map(t => t.id)).toEqual(['close_requested']);
    });

    test('a request is rejected with an explanatory message so the value is never committed', async () => {
      const device = createDevice();
      await device.onInit();

      const openResult = await requestViaCapability(device, 'garagedoor_closed', false);
      expect(openResult).toEqual({ rejected: true, message: 'i18n:request.open' });
      expect(device._caps.garagedoor_closed).toBe(true);

      await device.setReportedState('open');
      const closeResult = await requestViaCapability(device, 'garagedoor_closed', true);
      expect(closeResult).toEqual({ rejected: true, message: 'i18n:request.close' });
      expect(device._caps.garagedoor_closed).toBe(false);
    });

    test('a request never touches the garagedoor_state capability or the store', async () => {
      const device = createDevice();
      await device.onInit();

      await requestViaCapability(device, 'garagedoor_closed', false);

      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._store.reportedState).toBe('closed');
    });
  });

  describe('requests through the request action cards', () => {
    test('request() fires the matching trigger without touching any state', async () => {
      const device = createDevice();
      await device.onInit();

      await device.request('open');
      await device.request('close');

      expect(device._triggered.map(t => t.id)).toEqual(['open_requested', 'close_requested']);
      expect(device._caps.garagedoor_closed).toBe(true);
      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._store.reportedState).toBe('closed');
    });
  });

  describe('mode migration', () => {
    test('devices from before Managed mode existed migrate to flow mode', async () => {
      const device = createDevice();
      delete device._settings.mode;
      await device.onInit();

      expect(device.setSettings).toHaveBeenCalledWith({ mode: 'flow' });
      expect(device._settings.mode).toBe('flow');
    });
  });

  describe('reports', () => {
    test.each([
      ['closed', true],
      ['opening', false],
      ['open', false],
      ['closing', false],
      ['stopped', false],
    ])('reporting %s sets garagedoor_closed to %s', async (state, closed) => {
      const device = createDevice();
      await device.onInit();

      await device.setReportedState(state);

      expect(device._caps.garagedoor_state).toBe(state);
      expect(device._caps.garagedoor_closed).toBe(closed);
      expect(device._store.reportedState).toBe(state);
    });

    test('rejects unknown states without changing anything', async () => {
      const device = createDevice();
      await device.onInit();

      await expect(device.setReportedState('ajar')).rejects.toThrow(/Unknown garage door state/);

      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._caps.garagedoor_closed).toBe(true);
      expect(device._store.reportedState).toBe('closed');
    });

    test('reports alone never fire request triggers', async () => {
      const device = createDevice();
      await device.onInit();

      for (const state of STATES) {
        await device.setReportedState(state);
      }

      expect(device._triggered).toEqual([]);
    });
  });

  test('full cycle: request open, report opening/open, request close, report closing/closed', async () => {
    const device = createDevice();
    await device.onInit();

    await requestViaCapability(device, 'garagedoor_closed', false);
    expect(device._caps.garagedoor_closed).toBe(true); // request alone changes nothing

    await device.setReportedState('opening');
    expect(device._caps.garagedoor_closed).toBe(false);
    expect(device._caps.garagedoor_state).toBe('opening');

    await device.setReportedState('open');
    expect(device._caps.garagedoor_state).toBe('open');

    await requestViaCapability(device, 'garagedoor_closed', true);
    expect(device._caps.garagedoor_closed).toBe(false); // still open until reported

    await device.setReportedState('closing');
    expect(device._caps.garagedoor_state).toBe('closing');

    await device.setReportedState('closed');
    expect(device._caps.garagedoor_closed).toBe(true);
    expect(device._caps.garagedoor_state).toBe('closed');
    expect(device._triggered.map(t => t.id)).toEqual(['open_requested', 'close_requested']);
  });
});
