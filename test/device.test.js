'use strict';

const VirtualGarageDoorDevice = require('../lib/virtual-door-device');
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

  describe('open restriction (only when someone is home)', () => {
    const { createApi } = require('./helpers');

    test('"always" opens without ever touching the users API', async () => {
      const api = createApi({}, { users: { a: { id: 'a', present: false } } });
      const device = createDevice({ api, settings: { open_restriction: 'always' } });
      await device.onInit();

      await device.request('open');

      expect(device._triggered.map(t => t.id)).toEqual(['open_requested']);
      expect(api.users.getUsers).not.toHaveBeenCalled();
    });

    test('blocks open requests before any trigger fires when nobody is home', async () => {
      const api = createApi({}, { users: { a: { id: 'a', present: false }, b: { id: 'b', present: false } } });
      const device = createDevice({ api, settings: { open_restriction: 'home_strict' } });
      await device.onInit();

      const viaTile = await requestViaCapability(device, 'garagedoor_closed', false);
      expect(viaTile).toEqual({ rejected: true, message: 'i18n:request.nobody_home' });
      await expect(device.request('open')).rejects.toThrow('i18n:request.nobody_home');

      expect(device._triggered).toEqual([]); // Flows never hear a blocked request
      expect(device._caps.garagedoor_closed).toBe(true);
      // the users list must be fetched fresh — homey-api's cache would keep
      // the presence from the first lookup forever
      expect(api.users.getUsers).toHaveBeenCalledWith({ $cache: false });
    });

    test('a blocked capability open schedules the cache re-assert for Apple Home', async () => {
      const api = createApi({}, { users: { a: { id: 'a', present: false } } });
      const device = createDevice({ api, settings: { open_restriction: 'home_strict' } });
      await device.onInit();

      await requestViaCapability(device, 'garagedoor_closed', false);

      const reassert = device._timers.find(t => !t.cleared && t.ms === 1500);
      expect(reassert).toBeDefined();
      reassert.cleared = true;
      reassert.fn();
      await new Promise(resolve => setImmediate(resolve));
      expect(device._caps.garagedoor_closed).toBe(true); // snapped back to closed
    });

    test('presence is read fresh, never from the cached snapshot (regression)', async () => {
      const api = createApi({}, { users: { a: { id: 'a', present: true } } });
      const device = createDevice({ api, settings: { open_restriction: 'home_lenient' } });
      await device.onInit();

      await device.request('open'); // someone is home: allowed
      expect(device._triggered.map(t => t.id)).toEqual(['open_requested']);

      api._users.a.present = false; // everyone leaves; only the live state changes

      // fails if the code reads homey-api's cached snapshot (present: true)
      await expect(device.request('open')).rejects.toThrow('i18n:request.nobody_home');
      expect(device._triggered.map(t => t.id)).toEqual(['open_requested']); // no second trigger
    });

    test('closing is never blocked, even under strict with a broken lookup', async () => {
      const device = createDevice({ api: createApi({}), settings: { open_restriction: 'home_strict' } });
      device.homey.app.getApi = jest.fn(async () => {
        throw new Error('api unavailable');
      });
      await device.onInit();
      await device.setReportedState('open');

      await device.request('close');

      expect(device._triggered.map(t => t.id)).toEqual(['close_requested']);
    });

    test('allows opening when someone is home', async () => {
      const device = createDevice({
        api: createApi({}, { users: { a: { id: 'a', present: false }, b: { id: 'b', present: true } } }),
        settings: { open_restriction: 'home_strict' },
      });
      await device.onInit();

      await device.request('open');

      expect(device._triggered.map(t => t.id)).toEqual(['open_requested']);
    });

    test('a failed lookup refuses the open under strict, allows it under lenient', async () => {
      const brokenApi = () => {
        const api = createApi({});
        api.users.getUsers = jest.fn(async () => {
          throw new Error('missing scopes');
        });
        return api;
      };

      const strict = createDevice({ api: brokenApi(), settings: { open_restriction: 'home_strict' } });
      await strict.onInit();
      const viaTile = await requestViaCapability(strict, 'garagedoor_closed', false);
      expect(viaTile).toEqual({ rejected: true, message: 'i18n:request.presence_unknown' });
      expect(strict._triggered).toEqual([]);

      const lenient = createDevice({ api: brokenApi(), settings: { open_restriction: 'home_lenient' } });
      await lenient.onInit();
      await lenient.request('open'); // benefit of the doubt, by explicit choice
      expect(lenient._triggered.map(t => t.id)).toEqual(['open_requested']);
    });

    test('the legacy checkbox migrates to the matching dropdown choice', async () => {
      const api = createApi({}, { users: { a: { id: 'a', present: false } } });
      const legacyOn = createDevice({ api, settings: { only_open_when_home: true } });
      await legacyOn.onInit();

      // old documented behavior = restricted but allowed on lookup failure
      expect(legacyOn._settings.open_restriction).toBe('home_lenient');
      await expect(legacyOn.request('open')).rejects.toThrow('i18n:request.nobody_home');

      const legacyOff = createDevice({ settings: { only_open_when_home: false } });
      await legacyOff.onInit();
      expect(legacyOff._settings.open_restriction).toBe('always');

      const explicit = createDevice({ settings: { open_restriction: 'home_strict', only_open_when_home: true } });
      await explicit.onInit();
      expect(explicit._settings.open_restriction).toBe('home_strict'); // never overwritten
    });
  });

  describe('HomeKitty cache re-assert', () => {
    test('a close request re-emits the sensor-anchored value shortly after', async () => {
      const device = createDevice();
      await device.onInit();
      await device.setReportedState('open');
      device.setCapabilityValue.mockClear();

      await requestViaCapability(device, 'garagedoor_closed', true);

      const reassert = device._timers.find(t => !t.cleared && t.ms === 1500);
      expect(reassert).toBeDefined();
      reassert.cleared = true;
      reassert.fn();
      await new Promise(resolve => setImmediate(resolve));
      // still open: the rejected write must not stick anywhere
      expect(device.setCapabilityValue).toHaveBeenCalledWith('garagedoor_closed', false);
    });

    test('open requests schedule no re-assert, keeping the Opening… transient alive', async () => {
      const device = createDevice();
      await device.onInit();

      await requestViaCapability(device, 'garagedoor_closed', false);

      expect(device._timers.filter(t => !t.cleared)).toHaveLength(0);
    });
  });

  describe('reports', () => {
    test.each([
      ['closed', true],
      ['opening', true], // endpoint-hold: reads closed until (presumed) open
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
    expect(device._caps.garagedoor_closed).toBe(true); // endpoint-hold: Apple keeps "Opening…"
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
