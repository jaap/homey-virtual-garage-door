'use strict';

const { pulse, elapsed, restore } = require('../lib/gate-cycle-machine');

describe('gate cycle machine', () => {
  test('a pulse from closed starts opening', () => {
    const r = pulse({ phase: 'closed' });
    expect(r.state.phase).toBe('opening');
    expect(r.effects).toEqual(['pulse', 'timer-start']);
  });

  test('the cycle advances opening → open → closing → closed on timer expiry', () => {
    let r = elapsed({ phase: 'opening' });
    expect(r.state.phase).toBe('open');
    expect(r.effects).toEqual(['timer-start']);

    r = elapsed(r.state);
    expect(r.state.phase).toBe('closing');
    expect(r.effects).toEqual(['timer-start']);

    r = elapsed(r.state);
    expect(r.state.phase).toBe('closed');
    expect(r.effects).toEqual([]); // cycle finished, no further timer
  });

  test('a kick while opening re-pulses and restarts the opening clock', () => {
    const r = pulse({ phase: 'opening' });
    expect(r.state.phase).toBe('opening');
    expect(r.effects).toEqual(['pulse', 'timer-start']);
  });

  test('a kick while open re-pulses and restarts the hold ("keep it open longer")', () => {
    const r = pulse({ phase: 'open' });
    expect(r.state.phase).toBe('open');
    expect(r.effects).toEqual(['pulse', 'timer-start']);
  });

  test('a kick while closing reverses the gate up: full opening time again', () => {
    const r = pulse({ phase: 'closing' });
    expect(r.state.phase).toBe('opening');
    expect(r.effects).toEqual(['pulse', 'timer-start']);
  });

  test('a stale timer in closed does nothing', () => {
    const r = elapsed({ phase: 'closed' });
    expect(r.state.phase).toBe('closed');
    expect(r.effects).toEqual([]);
  });

  test('restore always settles on closed without pulses or timers', () => {
    const r = restore();
    expect(r.state.phase).toBe('closed');
    expect(r.effects).toEqual([]);
  });
});
