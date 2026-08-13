'use strict';

/**
 * Pure state machine for Managed mode. No timers, no I/O, no Homey — the
 * caller owns those. Every function takes a state and returns the next
 * state plus a list of effects for the caller to execute:
 *
 *   'pulse'                       trigger the control device
 *   'timer-start' / 'timer-stop'  (re)arm or cancel the travel timer
 *   { type: 'failed', direction } the door did not reach its endpoint
 *   { type: 'warn', id }          show a device warning
 *   'warn-clear'                  clear the device warning
 *   { type: 'reject', reason }    a request was refused, with the reason
 *
 * State shape: { phase, closedActive, openActive }
 *   phase        one of PHASES
 *   closedActive door is at the fully-closed endpoint (sensor, post-invert)
 *   openActive   door is at the fully-open endpoint, or null without sensor
 *
 * Direction while between endpoints always comes from the command or the
 * endpoint the door just left — endpoint sensors alone cannot measure it.
 */

const PHASES = ['closed', 'opening', 'open', 'closing', 'stopped'];

const inConflict = state => state.closedActive === true && state.openActive === true;

/**
 * Handle an open/close request (device tile, HomeKit, request Flow cards).
 * Pulses only from settled phases; conservative while already moving,
 * because a pulse while moving has no universal meaning across openers.
 */
function request(state, direction) {
  if (inConflict(state)) {
    return { state, effects: [{ type: 'reject', reason: 'sensor_conflict' }] };
  }
  const { phase } = state;
  if (phase === 'opening' || phase === 'closing') {
    return { state, effects: [{ type: 'reject', reason: 'already_moving' }] };
  }
  if (direction === 'open' && phase === 'open') {
    return { state, effects: [{ type: 'reject', reason: 'already_open' }] };
  }
  if (direction === 'close' && phase === 'closed') {
    return { state, effects: [{ type: 'reject', reason: 'already_closed' }] };
  }
  // settled phase (closed, open or stopped): act, and take the commanded
  // direction as the movement direction
  return {
    state: { ...state, phase: direction === 'open' ? 'opening' : 'closing' },
    effects: ['pulse', 'timer-start'],
  };
}

/**
 * Handle a sensor endpoint change (post-invert). Endpoint sensors are the
 * source of truth: reaching an endpoint always settles the phase, whoever
 * caused the movement. Leaving an endpoint without a command means manual
 * or external operation; the direction is inferred from the endpoint the
 * door just left, and the travel timeout still applies.
 */
function sensor(state, which, active) {
  const next = {
    ...state,
    [which === 'closed' ? 'closedActive' : 'openActive']: active,
  };

  if (inConflict(next)) {
    // both endpoints at once: sensor/configuration error — never pulse,
    // keep the phase, warn
    return { state: next, effects: [{ type: 'warn', id: 'sensor_conflict' }] };
  }

  const conflictResolved = inConflict(state) && !inConflict(next);

  if (which === 'closed') {
    if (active) {
      return { state: { ...next, phase: 'closed' }, effects: ['timer-stop', 'warn-clear'] };
    }
    if (conflictResolved) {
      // closed dropped while open still active: the open endpoint wins
      return { state: { ...next, phase: 'open' }, effects: ['timer-stop', 'warn-clear'] };
    }
    if (state.phase === 'closed') {
      // unexpected departure from closed: likely opening (manual/external)
      return { state: { ...next, phase: 'opening' }, effects: ['timer-start'] };
    }
    return { state: next, effects: [] }; // expected during opening
  }

  // which === 'open'
  if (active) {
    return { state: { ...next, phase: 'open' }, effects: ['timer-stop', 'warn-clear'] };
  }
  if (conflictResolved) {
    return { state: { ...next, phase: 'closed' }, effects: ['timer-stop', 'warn-clear'] };
  }
  if (state.phase === 'open') {
    // unexpected departure from open: likely closing (manual/external)
    return { state: { ...next, phase: 'closing' }, effects: ['timer-start'] };
  }
  return { state: next, effects: [] }; // expected during closing
}

/**
 * Handle expiry of the travel timer.
 * - Opening with an open sensor: the endpoint was not reached — failure.
 * - Opening without an open sensor: fully open is unobservable, so OPEN is
 *   inferred from elapsed travel time (documented one-sensor asymmetry).
 * - Closing: the closed sensor is always present and authoritative — never
 *   claim CLOSED from a timer; this is a failure.
 */
function timeout(state, { hasOpenSensor }) {
  if (state.phase === 'opening') {
    if (hasOpenSensor) {
      return {
        state: { ...state, phase: 'stopped' },
        effects: [{ type: 'failed', direction: 'opening' }, { type: 'warn', id: 'not_reached_open' }],
      };
    }
    return { state: { ...state, phase: 'open' }, effects: [] };
  }
  if (state.phase === 'closing') {
    return {
      state: { ...state, phase: 'stopped' },
      effects: [{ type: 'failed', direction: 'closing' }, { type: 'warn', id: 'not_reached_closed' }],
    };
  }
  return { state, effects: [] }; // stale timer, nothing to do
}

/**
 * Externally force a phase (the "Report the door state" Flow card as an
 * escape hatch in Managed mode).
 */
function force(state, phase) {
  if (!PHASES.includes(phase)) {
    throw new Error(`Unknown garage door state: ${phase}`);
  }
  return { state: { ...state, phase }, effects: ['timer-stop', 'warn-clear'] };
}

/**
 * Reconcile after an app/Homey restart. Sensors win where they can; between
 * endpoints the movement direction is unknown, so be conservative: no
 * pulses, no timers, no failure events. Without an open sensor, a stored
 * open/opening phase stays OPEN (consistent with an inactive closed
 * sensor); anything else between endpoints becomes STOPPED.
 */
function restore({ closedActive, openActive, storedPhase, hasOpenSensor }) {
  const base = { closedActive, openActive: hasOpenSensor ? openActive : null };
  if (hasOpenSensor && closedActive && openActive) {
    return { state: { ...base, phase: 'stopped' }, effects: [{ type: 'warn', id: 'sensor_conflict' }] };
  }
  if (closedActive) {
    return { state: { ...base, phase: 'closed' }, effects: ['warn-clear'] };
  }
  if (hasOpenSensor && openActive) {
    return { state: { ...base, phase: 'open' }, effects: ['warn-clear'] };
  }
  if (!hasOpenSensor && (storedPhase === 'open' || storedPhase === 'opening')) {
    return { state: { ...base, phase: 'open' }, effects: [] };
  }
  return { state: { ...base, phase: 'stopped' }, effects: [] };
}

module.exports = { PHASES, request, sensor, timeout, force, restore };
