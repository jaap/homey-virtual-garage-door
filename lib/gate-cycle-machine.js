'use strict';

/**
 * Pure cycle machine for auto-closing gates (Managed mode without sensors).
 *
 * The physical model: a pulse always means "go up / stay up". The gate opens,
 * stays open for a while, then closes again by itself. There are no sensors,
 * so every phase is simulated by dead reckoning; the caller owns the timers
 * (one timer, whose duration depends on the phase just entered) and the
 * control-device pulse.
 *
 *   closed --pulse--> opening --> open --> closing --> closed
 *                        ▲          ▲         │
 *                        │   pulse restarts   │
 *                        │   the hold timer   │
 *                        └── pulse while closing reverses up ──┘
 *
 * Effects: 'pulse' (trigger the control device) and 'timer-start' (arm the
 * phase timer for the phase in the returned state).
 */

const PHASES = ['closed', 'opening', 'open', 'closing'];

/**
 * An open request or "kick", valid in every phase:
 * - closed/closing: the gate starts (or reverses to) opening — full opening
 *   time from now, since the position mid-travel is unknown;
 * - opening: re-pulse (the gate ignores it) and restart the opening clock;
 * - open: re-pulse — the gate restarts its own auto-close hold, so the
 *   simulated hold restarts too ("keep it open a bit longer").
 */
function pulse(state) {
  const phase = state.phase === 'open' ? 'open' : 'opening';
  return { state: { ...state, phase }, effects: ['pulse', 'timer-start'] };
}

/** The current phase's timer expired: advance the simulated cycle. */
function elapsed(state) {
  switch (state.phase) {
    case 'opening':
      return { state: { ...state, phase: 'open' }, effects: ['timer-start'] };
    case 'open':
      return { state: { ...state, phase: 'closing' }, effects: ['timer-start'] };
    case 'closing':
      return { state: { ...state, phase: 'closed' }, effects: [] };
    default:
      return { state, effects: [] }; // stale timer
  }
}

/**
 * Reconcile after a restart. The gate always closes by itself and a restart
 * takes longer than a cycle, so the only defensible assumption is closed.
 * Never pulse, never start timers.
 */
function restore() {
  return { state: { phase: 'closed' }, effects: [] };
}

module.exports = { PHASES, pulse, elapsed, restore };
