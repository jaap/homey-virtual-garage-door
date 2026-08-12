'use strict';

const VirtualGarageDoorDevice = require('../drivers/garagedoor/device');
const { createDevice, externalSet } = require('./helpers');

const { STATES, REQUEST_REVERT_MS } = VirtualGarageDoorDevice;
const AFTER_REVERT_WINDOW = REQUEST_REVERT_MS + 50;

describe('VirtualGarageDoorDevice', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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
      // e.g. Homey went down right after a request, before the revert ran
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

  describe('requests', () => {
    test('an open request fires the open_requested trigger for this device', async () => {
      const device = createDevice();
      await device.onInit();

      await externalSet(device, 'garagedoor_closed', false);

      expect(device._triggered).toHaveLength(1);
      expect(device._triggered[0].id).toBe('open_requested');
      expect(device._triggered[0].device).toBe(device);
    });

    test('a close request fires the close_requested trigger', async () => {
      const device = createDevice();
      await device.onInit();
      await device.setReportedState('open');

      await externalSet(device, 'garagedoor_closed', true);

      expect(device._triggered.map(t => t.id)).toEqual(['close_requested']);
    });

    test('a request never touches the garagedoor_state capability or the store', async () => {
      const device = createDevice();
      await device.onInit();

      await externalSet(device, 'garagedoor_closed', false);

      expect(device._caps.garagedoor_state).toBe('closed');
      expect(device._store.reportedState).toBe('closed');
    });

    test('an unconfirmed request reverts to the last reported state after the revert window', async () => {
      const device = createDevice();
      await device.onInit();

      await externalSet(device, 'garagedoor_closed', false);
      // Homey Core has stored the optimistic value at this point
      expect(device._caps.garagedoor_closed).toBe(false);

      await jest.advanceTimersByTimeAsync(AFTER_REVERT_WINDOW);

      expect(device._caps.garagedoor_closed).toBe(true);
      expect(device._caps.garagedoor_state).toBe('closed');
    });

    test('an unconfirmed close request reverts to open when open was last reported', async () => {
      const device = createDevice();
      await device.onInit();
      await device.setReportedState('open');

      await externalSet(device, 'garagedoor_closed', true);
      await jest.advanceTimersByTimeAsync(AFTER_REVERT_WINDOW);

      expect(device._caps.garagedoor_closed).toBe(false);
      expect(device._caps.garagedoor_state).toBe('open');
    });

    test('a request confirmed by a report within the window is not reverted', async () => {
      const device = createDevice();
      await device.onInit();

      await externalSet(device, 'garagedoor_closed', false);
      await device.setReportedState('opening');
      await jest.advanceTimersByTimeAsync(AFTER_REVERT_WINDOW);

      expect(device._caps.garagedoor_closed).toBe(false);
      expect(device._caps.garagedoor_state).toBe('opening');
    });

    test('rapid repeated requests followed by a report keep the reported state', async () => {
      const device = createDevice();
      await device.onInit();

      await externalSet(device, 'garagedoor_closed', false);
      await jest.advanceTimersByTimeAsync(100);
      await externalSet(device, 'garagedoor_closed', false);
      await device.setReportedState('opening');
      await jest.advanceTimersByTimeAsync(AFTER_REVERT_WINDOW * 2);

      expect(device._caps.garagedoor_closed).toBe(false);
      expect(device._caps.garagedoor_state).toBe('opening');
      expect(device._triggered.map(t => t.id)).toEqual(['open_requested', 'open_requested']);
    });

    test('a report arriving during the revert window of an opposite request wins', async () => {
      const device = createDevice();
      await device.onInit();
      await device.setReportedState('open');

      // Close is requested and the sensor confirms closed almost immediately
      await externalSet(device, 'garagedoor_closed', true);
      await device.setReportedState('closed');
      await jest.advanceTimersByTimeAsync(AFTER_REVERT_WINDOW);

      expect(device._caps.garagedoor_closed).toBe(true);
      expect(device._caps.garagedoor_state).toBe('closed');
    });
  });

  describe('reports', () => {
    test.each([
      ['closed', true],
      ['opening', false],
      ['open', false],
      ['closing', false],
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

    await externalSet(device, 'garagedoor_closed', false);
    await device.setReportedState('opening');
    expect(device._caps.garagedoor_closed).toBe(false);
    expect(device._caps.garagedoor_state).toBe('opening');

    await device.setReportedState('open');
    expect(device._caps.garagedoor_state).toBe('open');

    await externalSet(device, 'garagedoor_closed', true);
    await device.setReportedState('closing');
    expect(device._caps.garagedoor_closed).toBe(false);
    expect(device._caps.garagedoor_state).toBe('closing');

    await device.setReportedState('closed');
    await jest.advanceTimersByTimeAsync(AFTER_REVERT_WINDOW * 2);

    expect(device._caps.garagedoor_closed).toBe(true);
    expect(device._caps.garagedoor_state).toBe('closed');
    expect(device._triggered.map(t => t.id)).toEqual(['open_requested', 'close_requested']);
  });
});
