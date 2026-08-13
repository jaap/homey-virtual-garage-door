'use strict';

const { PHASES, request, sensor, timeout, force, restore } = require('../lib/garage-state-machine');

const TWO = { hasOpenSensor: true };
const ONE = { hasOpenSensor: false };

const closedState = { phase: 'closed', closedActive: true, openActive: false };
const openStateTwo = { phase: 'open', closedActive: false, openActive: true };
const openStateOne = { phase: 'open', closedActive: false, openActive: null };

describe('garage state machine', () => {
  test('exposes the five phases in capability order', () => {
    expect(PHASES).toEqual(['closed', 'opening', 'open', 'closing', 'stopped']);
  });

  describe('normal cycle with two sensors', () => {
    test('closed → request open → opening (pulse, timer)', () => {
      const r = request(closedState, 'open');
      expect(r.state.phase).toBe('opening');
      expect(r.effects).toEqual(['pulse', 'timer-start']);
    });

    test('opening: leaving the closed endpoint keeps OPENING', () => {
      const opening = { phase: 'opening', closedActive: true, openActive: false };
      const r = sensor(opening, 'closed', false);
      expect(r.state.phase).toBe('opening');
      expect(r.effects).toEqual([]);
    });

    test('opening: open endpoint reached → OPEN, timer stopped', () => {
      const opening = { phase: 'opening', closedActive: false, openActive: false };
      const r = sensor(opening, 'open', true);
      expect(r.state.phase).toBe('open');
      expect(r.effects).toEqual(['timer-stop', 'warn-clear']);
    });

    test('open → request close → closing, then endpoints settle CLOSED', () => {
      let r = request(openStateTwo, 'close');
      expect(r.state.phase).toBe('closing');
      expect(r.effects).toEqual(['pulse', 'timer-start']);

      r = sensor(r.state, 'open', false);
      expect(r.state.phase).toBe('closing');

      r = sensor(r.state, 'closed', true);
      expect(r.state.phase).toBe('closed');
      expect(r.effects).toEqual(['timer-stop', 'warn-clear']);
    });
  });

  describe('one sensor (closed only)', () => {
    test('opening: travel time expiry infers OPEN, not a failure', () => {
      const opening = { phase: 'opening', closedActive: false, openActive: null };
      const r = timeout(opening, ONE);
      expect(r.state.phase).toBe('open');
      expect(r.effects).toEqual([]);
    });

    test('closing: closed sensor is authoritative for CLOSED', () => {
      const closing = { phase: 'closing', closedActive: false, openActive: null };
      const r = sensor(closing, 'closed', true);
      expect(r.state.phase).toBe('closed');
    });

    test('closing: timeout without the closed sensor firing is a failure, never CLOSED', () => {
      const closing = { phase: 'closing', closedActive: false, openActive: null };
      const r = timeout(closing, ONE);
      expect(r.state.phase).toBe('stopped');
      expect(r.effects).toContainEqual({ type: 'failed', direction: 'closing' });
      expect(r.effects).toContainEqual({ type: 'warn', id: 'not_reached_closed' });
    });
  });

  describe('two sensors: timeout is a failure, never an endpoint claim', () => {
    test('opening timeout → STOPPED + failed(opening)', () => {
      const opening = { phase: 'opening', closedActive: false, openActive: false };
      const r = timeout(opening, TWO);
      expect(r.state.phase).toBe('stopped');
      expect(r.effects).toContainEqual({ type: 'failed', direction: 'opening' });
      expect(r.effects).toContainEqual({ type: 'warn', id: 'not_reached_open' });
    });

    test('closing timeout → STOPPED + failed(closing)', () => {
      const closing = { phase: 'closing', closedActive: false, openActive: false };
      const r = timeout(closing, TWO);
      expect(r.state.phase).toBe('stopped');
      expect(r.effects).toContainEqual({ type: 'failed', direction: 'closing' });
    });

    test('a stale timeout in a settled phase does nothing', () => {
      for (const phase of ['closed', 'open', 'stopped']) {
        const r = timeout({ phase, closedActive: false, openActive: false }, TWO);
        expect(r.state.phase).toBe(phase);
        expect(r.effects).toEqual([]);
      }
    });
  });

  describe('manual / external operation', () => {
    test('closed: closed sensor drops without a command → likely OPENING, timer armed', () => {
      const r = sensor(closedState, 'closed', false);
      expect(r.state.phase).toBe('opening');
      expect(r.effects).toEqual(['timer-start']);
    });

    test('…and the open sensor eventually confirms OPEN', () => {
      const opening = { phase: 'opening', closedActive: false, openActive: false };
      const r = sensor(opening, 'open', true);
      expect(r.state.phase).toBe('open');
    });

    test('open: open sensor drops without a command → likely CLOSING, timer armed', () => {
      const r = sensor(openStateTwo, 'open', false);
      expect(r.state.phase).toBe('closing');
      expect(r.effects).toEqual(['timer-start']);
    });

    test('manual close is confirmed by the closed sensor from any phase', () => {
      const stopped = { phase: 'stopped', closedActive: false, openActive: false };
      const r = sensor(stopped, 'closed', true);
      expect(r.state.phase).toBe('closed');
    });

    test('one sensor: manual opening also times out into inferred OPEN', () => {
      const r1 = sensor({ ...closedState, openActive: null }, 'closed', false);
      expect(r1.state.phase).toBe('opening');
      const r2 = timeout(r1.state, ONE);
      expect(r2.state.phase).toBe('open');
    });
  });

  describe('command guarding', () => {
    test('same-state requests do nothing', () => {
      expect(request(closedState, 'close').effects).toEqual([{ type: 'reject', reason: 'already_closed' }]);
      expect(request(openStateTwo, 'open').effects).toEqual([{ type: 'reject', reason: 'already_open' }]);
      expect(request(closedState, 'close').state.phase).toBe('closed');
    });

    test('requests while moving are refused (no pulse — pulse meaning varies per opener)', () => {
      for (const phase of ['opening', 'closing']) {
        for (const direction of ['open', 'close']) {
          const r = request({ phase, closedActive: false, openActive: false }, direction);
          expect(r.state.phase).toBe(phase);
          expect(r.effects).toEqual([{ type: 'reject', reason: 'already_moving' }]);
        }
      }
    });

    test('requests from STOPPED act and take the commanded direction', () => {
      const stopped = { phase: 'stopped', closedActive: false, openActive: false };
      expect(request(stopped, 'open').state.phase).toBe('opening');
      expect(request(stopped, 'close').state.phase).toBe('closing');
      expect(request(stopped, 'open').effects).toEqual(['pulse', 'timer-start']);
    });
  });

  describe('conflicting sensor states', () => {
    const conflicted = { phase: 'closed', closedActive: true, openActive: true };

    test('both endpoints active → warning, phase kept, no pulse', () => {
      const r = sensor(closedState, 'open', true);
      expect(r.effects).toEqual([{ type: 'warn', id: 'sensor_conflict' }]);
      expect(r.state.phase).toBe('closed');
    });

    test('requests during a conflict are refused', () => {
      const r = request(conflicted, 'open');
      expect(r.effects).toEqual([{ type: 'reject', reason: 'sensor_conflict' }]);
    });

    test('conflict resolves toward the endpoint that stays active', () => {
      let r = sensor(conflicted, 'closed', false);
      expect(r.state.phase).toBe('open');
      expect(r.effects).toEqual(['timer-stop', 'warn-clear']);

      r = sensor(conflicted, 'open', false);
      expect(r.state.phase).toBe('closed');
      expect(r.effects).toEqual(['timer-stop', 'warn-clear']);
    });
  });

  describe('restart reconciliation (restore)', () => {
    test('closed sensor active wins, whatever was stored', () => {
      for (const storedPhase of PHASES) {
        const r = restore({ closedActive: true, openActive: false, storedPhase, hasOpenSensor: true });
        expect(r.state.phase).toBe('closed');
      }
    });

    test('open sensor active wins with two sensors', () => {
      const r = restore({ closedActive: false, openActive: true, storedPhase: 'closing', hasOpenSensor: true });
      expect(r.state.phase).toBe('open');
    });

    test('two sensors, between endpoints → STOPPED (direction unknowable)', () => {
      for (const storedPhase of PHASES) {
        const r = restore({ closedActive: false, openActive: false, storedPhase, hasOpenSensor: true });
        expect(r.state.phase).toBe('stopped');
        expect(r.effects).toEqual([]);
      }
    });

    test('one sensor, not closed: stored open/opening stays OPEN, anything else STOPPED', () => {
      expect(restore({ closedActive: false, openActive: null, storedPhase: 'open', hasOpenSensor: false }).state.phase).toBe('open');
      expect(restore({ closedActive: false, openActive: null, storedPhase: 'opening', hasOpenSensor: false }).state.phase).toBe('open');
      for (const storedPhase of ['closed', 'closing', 'stopped']) {
        expect(restore({ closedActive: false, openActive: null, storedPhase, hasOpenSensor: false }).state.phase).toBe('stopped');
      }
    });

    test('both sensors active at boot → STOPPED with conflict warning', () => {
      const r = restore({ closedActive: true, openActive: true, storedPhase: 'closed', hasOpenSensor: true });
      expect(r.state.phase).toBe('stopped');
      expect(r.effects).toEqual([{ type: 'warn', id: 'sensor_conflict' }]);
    });

    test('restore never pulses, never starts timers, never reports failures', () => {
      for (const closedActive of [true, false]) {
        for (const openActive of [true, false]) {
          for (const storedPhase of PHASES) {
            const { effects } = restore({ closedActive, openActive, storedPhase, hasOpenSensor: true });
            expect(effects).not.toContain('pulse');
            expect(effects).not.toContain('timer-start');
            expect(effects.filter(e => e.type === 'failed')).toEqual([]);
          }
        }
      }
    });
  });

  describe('force (Flow escape hatch)', () => {
    test('applies any valid phase and clears timer/warning', () => {
      const r = force({ phase: 'stopped', closedActive: false, openActive: false }, 'open');
      expect(r.state.phase).toBe('open');
      expect(r.effects).toEqual(['timer-stop', 'warn-clear']);
    });

    test('rejects unknown phases', () => {
      expect(() => force(closedState, 'ajar')).toThrow(/Unknown garage door state/);
    });
  });

  test('one-sensor open state round trip: request close from inferred OPEN', () => {
    const r = request(openStateOne, 'close');
    expect(r.state.phase).toBe('closing');
    expect(r.effects).toEqual(['pulse', 'timer-start']);
  });
});
