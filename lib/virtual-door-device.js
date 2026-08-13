'use strict';

const Homey = require('homey');
const StateMachine = require('./garage-state-machine');
const GateMachine = require('./gate-cycle-machine');

const { PHASES } = StateMachine;

const GATE_TIMER_SETTINGS = {
  opening: 'gate_opening_time',
  open: 'gate_hold_time',
  closing: 'gate_closing_time',
};
const GATE_TIMER_DEFAULTS = { opening: 10, open: 30, closing: 10 };

/**
 * The raw capability value that means "door is at this endpoint" before the
 * user's meaning setting is applied. `alarm_*` capabilities are true when
 * the contact is open, so the endpoint is reached when they are false;
 * plain booleans (onoff, custom inputs) default to true.
 */
function defaultActiveRaw(capabilityId) {
  return !capabilityId.startsWith('alarm_');
}

module.exports = class VirtualDoorDevice extends Homey.Device {

  static STATES = PHASES;

  /** Fixed operating mode of the driver: 'flow' | 'managed' | 'gate'. */
  static MODE = 'flow';

  async onInit() {
    if (!this.hasCapability('garagedoor_state')) {
      await this.addCapability('garagedoor_state');
    }

    this._openRequestedTrigger = this.homey.flow.getDeviceTriggerCard('open_requested');
    this._closeRequestedTrigger = this.homey.flow.getDeviceTriggerCard('close_requested');
    this._movementFailedTrigger = this.homey.flow.getDeviceTriggerCard('movement_failed');

    this.registerCapabilityListener('garagedoor_closed', value => this.request(value ? 'close' : 'open', { viaCapability: true }));
    if (this.hasCapability('button')) {
      // the always-available "kick" button on gate devices
      this.registerCapabilityListener('button', () => this.request('open'));
    }

    this._travelTimer = null;
    this._machineState = null;
    this._gate = null;

    if (this.isGate()) {
      await this._initGate();
    } else if (this.isManaged()) {
      await this._initManaged();
    } else {
      await this._initFlow();
    }
  }

  async onUninit() {
    this._teardownManaged();
  }

  async onDeleted() {
    this._teardownManaged();
  }

  getMode() {
    return this.constructor.MODE;
  }

  isManaged() {
    return this.getMode() === 'managed';
  }

  isGate() {
    return this.getMode() === 'gate';
  }

  async onSettings({ changedKeys }) {
    // re-initialize after the new settings have been committed
    if (changedKeys.some(key => ['mode', 'closed_sensor_meaning', 'open_sensor_meaning'].includes(key))) {
      this.homey.setTimeout(() => this._reinit().catch(this.error), 250);
    }
    // travel_time is read when the next travel timer starts
  }

  async _reinit() {
    this._teardownManaged();
    if (this.isGate()) {
      await this._initGate();
    } else if (this.isManaged()) {
      await this._initManaged();
    } else {
      await this.unsetWarning().catch(() => {});
      await this._initFlow();
    }
  }

  // ------------------------------------------------------------------ flow

  async _initFlow() {
    // Restore the last *reported* state; the store value is only ever
    // written when a state is applied, never by an unconfirmed request.
    let state = this.getStoreValue('reportedState');
    if (!PHASES.includes(state)) {
      state = this.getCapabilityValue('garagedoor_closed') === false ? 'open' : 'closed';
    }
    await this._applyPhase(state);
  }

  // --------------------------------------------------------------- managed

  async _initManaged() {
    const control = this.getStoreValue('controlDevice');
    const closed = this.getStoreValue('closedSensor');
    const open = this.getStoreValue('openSensor');

    if (!control || !closed) {
      await this._initFlow(); // keep last state visible
      await this.setWarning(this.homey.__('warning.not_configured')).catch(() => {});
      return;
    }

    try {
      const api = await this.homey.app.getApi();
      this._api = api;
      this._controlDevice = await api.devices.getDevice({ id: control.id });
      this._closedSensorDevice = await api.devices.getDevice({ id: closed.id });
      this._openSensorDevice = open ? await api.devices.getDevice({ id: open.id }) : null;
    } catch (err) {
      this.error('failed to resolve managed devices', err);
      await this._initFlow();
      await this.setWarning(this.homey.__('warning.missing_device')).catch(() => {});
      return;
    }

    this._closedInstance = this._closedSensorDevice.makeCapabilityInstance(
      closed.capability, raw => this._onSensorValue('closed', raw),
    );
    this._openInstance = this._openSensorDevice
      ? this._openSensorDevice.makeCapabilityInstance(open.capability, raw => this._onSensorValue('open', raw))
      : null;

    this._onApiDeviceDelete = item => {
      const id = item && item.id;
      const refs = [control.id, closed.id, open && open.id];
      if (refs.includes(id)) {
        this.error(`configured device ${id} was deleted`);
        this.setWarning(this.homey.__('warning.missing_device')).catch(() => {});
      }
    };
    this._api.devices.on('device.delete', this._onApiDeviceDelete);

    // reconcile conservatively: sensors win, no pulses, no timers
    const { state, effects } = StateMachine.restore({
      closedActive: this._sensorActive('closed', this._sensorRaw('closed')),
      openActive: this._openInstance ? this._sensorActive('open', this._sensorRaw('open')) : null,
      storedPhase: this.getStoreValue('reportedState'),
      hasOpenSensor: !!this._openInstance,
    });
    this._machineState = state;
    await this._runEffects(effects);
    await this._applyPhase(state.phase);

    this.setSettings({
      managed_devices_summary: [
        this._controlDevice.name,
        this._closedSensorDevice.name,
        this._openSensorDevice ? this._openSensorDevice.name : null,
      ].filter(Boolean).join(' · '),
    }).catch(() => {});

    this.log('managed mode initialized', JSON.stringify({ phase: state.phase, hasOpenSensor: !!this._openInstance }));
  }

  _teardownManaged() {
    this._stopTravelTimer();
    if (this._closedInstance) this._closedInstance.destroy();
    if (this._openInstance) this._openInstance.destroy();
    if (this._api && this._onApiDeviceDelete) {
      this._api.devices.off('device.delete', this._onApiDeviceDelete);
    }
    this._closedInstance = null;
    this._openInstance = null;
    this._controlDevice = null;
    this._closedSensorDevice = null;
    this._openSensorDevice = null;
    this._onApiDeviceDelete = null;
    this._machineState = null;
    this._gate = null;
  }

  // ------------------------------------------------------------------ gate

  /**
   * Auto-closing gate: Managed mode without sensors. The whole cycle is
   * simulated with the configured opening/hold/closing times, and a pulse
   * always means "go up / stay up" — including as a "kick" while the cycle
   * is running. Short times make the tile return to Closed quickly, so the
   * gate can be triggered again right away (also from Apple Home, whose
   * garage tile only accepts a new Open once the door reads Closed).
   */
  async _initGate() {
    const control = this.getStoreValue('controlDevice');
    if (!control) {
      await this._initFlow();
      await this.setWarning(this.homey.__('warning.not_configured')).catch(() => {});
      return;
    }

    try {
      const api = await this.homey.app.getApi();
      this._api = api;
      this._controlDevice = await api.devices.getDevice({ id: control.id });
    } catch (err) {
      this.error('failed to resolve gate control device', err);
      await this._initFlow();
      await this.setWarning(this.homey.__('warning.missing_device')).catch(() => {});
      return;
    }

    this._onApiDeviceDelete = item => {
      if (item && item.id === control.id) {
        this.error(`configured control device ${item.id} was deleted`);
        this.setWarning(this.homey.__('warning.missing_device')).catch(() => {});
      }
    };
    this._api.devices.on('device.delete', this._onApiDeviceDelete);

    // a restart outlives the short cycle: the gate has closed itself by now
    this._gate = GateMachine.restore().state;
    await this._applyPhase(this._gate.phase);
    await this.unsetWarning().catch(() => {});

    const times = ['opening', 'open', 'closing'].map(phase => this._gatePhaseSeconds(phase)).join('/');
    this.setSettings({
      managed_devices_summary: `${this._controlDevice.name} · ${times}s`,
    }).catch(() => {});

    this.log('gate mode initialized');
  }

  _gatePhaseSeconds(phase) {
    const value = Number(this.getSetting(GATE_TIMER_SETTINGS[phase]));
    return Number.isFinite(value) && value > 0 ? value : GATE_TIMER_DEFAULTS[phase];
  }

  _armGateTimer() {
    this._stopTravelTimer();
    if (!GATE_TIMER_SETTINGS[this._gate.phase]) return;
    const ms = this._gatePhaseSeconds(this._gate.phase) * 1000;
    this._travelTimer = this.homey.setTimeout(() => this._onGateElapsed(), ms);
  }

  _onGateElapsed() {
    this._travelTimer = null;
    if (!this._gate) return;
    const { state, effects } = GateMachine.elapsed(this._gate);
    this._gate = state;
    if (effects.includes('timer-start')) this._armGateTimer();
    this._applyPhase(state.phase).catch(this.error);
  }

  async _gatePulse() {
    if (!this._gate) {
      throw new Error(this.homey.__('request.not_configured'));
    }
    const { state, effects } = GateMachine.pulse(this._gate);
    this._gate = state;

    let pulseError = null;
    if (effects.includes('pulse')) {
      try {
        await this._pulse();
      } catch (err) {
        this.error('pulse failed', err);
        pulseError = err;
      }
    }
    if (effects.includes('timer-start')) this._armGateTimer();
    await this._applyPhase(state.phase);

    if (pulseError) {
      throw new Error(this.homey.__('request.control_failed'));
    }
  }

  _sensorRaw(which) {
    const instance = which === 'closed' ? this._closedInstance : this._openInstance;
    if (instance && instance.value !== null && instance.value !== undefined) return instance.value;
    const ref = this.getStoreValue(which === 'closed' ? 'closedSensor' : 'openSensor');
    const device = which === 'closed' ? this._closedSensorDevice : this._openSensorDevice;
    return device && device.capabilitiesObj && device.capabilitiesObj[ref.capability]
      ? device.capabilitiesObj[ref.capability].value
      : null;
  }

  _sensorActive(which, raw) {
    const ref = this.getStoreValue(which === 'closed' ? 'closedSensor' : 'openSensor');
    const meaning = this.getSetting(`${which}_sensor_meaning`) || 'default';
    let activeRaw = defaultActiveRaw(ref.capability);
    if (meaning === 'inverted') activeRaw = !activeRaw;
    return raw === activeRaw;
  }

  _onSensorValue(which, raw) {
    if (!this._machineState) return;
    const active = this._sensorActive(which, raw);
    this.log(`${which} sensor -> ${raw} (at endpoint: ${active})`);
    const { state, effects } = StateMachine.sensor(this._machineState, which, active);
    this._machineState = state;
    this._runEffects(effects)
      .then(() => this._applyPhase(state.phase))
      .catch(this.error);
  }

  _onTravelTimeout() {
    this._travelTimer = null;
    if (!this._machineState) return;
    const { state, effects } = StateMachine.timeout(this._machineState, { hasOpenSensor: !!this._openInstance });
    this._machineState = state;
    this._runEffects(effects)
      .then(() => this._applyPhase(state.phase))
      .catch(this.error);
  }

  _startTravelTimer() {
    this._stopTravelTimer();
    const seconds = Number(this.getSetting('travel_time')) || 20;
    this._travelTimer = this.homey.setTimeout(() => this._onTravelTimeout(), seconds * 1000);
  }

  _stopTravelTimer() {
    if (this._travelTimer) {
      this.homey.clearTimeout(this._travelTimer);
      this._travelTimer = null;
    }
  }

  async _pulse() {
    const control = this.getStoreValue('controlDevice');
    await this._controlDevice.setCapabilityValue({
      capabilityId: control.capability || 'onoff',
      value: true,
    });
    this.log('control device pulsed');
  }

  /**
   * Execute state machine effects. Returns the pulse error, if any, so the
   * request path can surface it; all other effects never throw.
   */
  async _runEffects(effects) {
    let pulseError = null;
    for (const effect of effects) {
      if (effect === 'pulse') {
        try {
          await this._pulse();
        } catch (err) {
          this.error('pulse failed', err);
          pulseError = err;
        }
      } else if (effect === 'timer-start') {
        this._startTravelTimer();
      } else if (effect === 'timer-stop') {
        this._stopTravelTimer();
      } else if (effect === 'warn-clear') {
        await this.unsetWarning().catch(() => {});
      } else if (effect && effect.type === 'warn') {
        await this.setWarning(this.homey.__(`warning.${effect.id}`)).catch(() => {});
      } else if (effect && effect.type === 'failed') {
        this.log(`movement failed while ${effect.direction}`);
        this._movementFailedTrigger.trigger(this, { direction: effect.direction }).catch(this.error);
      }
    }
    return pulseError;
  }

  // -------------------------------------------------------------- requests

  /**
   * Handle an open/close request from any source: the garagedoor_closed
   * capability (device tile, Apple Home via HomeKitty, built-in Flow cards)
   * or the "Request to open/close" Flow action cards.
   *
   * Flow controlled mode only emits the request trigger. When the request
   * came through the capability it then rejects, so Homey never commits a
   * state that nothing confirmed; HomeKitty swallows the rejection and
   * Apple Home keeps showing "Opening…"/"Closing…" until a report arrives.
   *
   * Managed mode runs the request through the state machine: it may pulse
   * the control device and start the travel timer, or refuse (already
   * moving, already there, sensor conflict).
   */
  /**
   * HomeKitty caches a HomeKit-written value even when this app rejects
   * the write, so an Apple Home read right after a tap can show the target
   * instead of the truth. Re-emitting the real value shortly after
   * refreshes HomeKitty's cache and characteristics. Scheduled for every
   * capability-path close request, and for refused capability-path open
   * requests (accepted opens keep their "Opening…" transient).
   */
  _scheduleCacheReassert() {
    this.homey.setTimeout(() => {
      const state = this.getStoreValue('reportedState');
      this.setCapabilityValue('garagedoor_closed', this._projectClosed(state)).catch(this.error);
    }, 1500);
  }

  async request(direction, { viaCapability = false } = {}) {
    if (viaCapability && direction === 'close') this._scheduleCacheReassert();
    // cleared on every accepted path; a throw while still set means the
    // open request was refused and Apple Home must snap back to the truth
    let reassertOnRefusal = viaCapability && direction === 'open';

    try {
      // The only-open-when-home restriction guards every request path in
      // every mode, and runs before the request triggers so Flows cannot
      // act on a blocked request either. Closing is never restricted.
      if (direction === 'open' && this.getSetting('only_open_when_home') === true && !(await this._someoneIsHome())) {
        this.log('open request blocked: nobody is home');
        throw new Error(this.homey.__('request.nobody_home'));
      }

      const trigger = direction === 'close' ? this._closeRequestedTrigger : this._openRequestedTrigger;
      trigger.trigger(this).catch(this.error);
      this.log(`${direction} requested${viaCapability ? ' (via capability)' : ''}`);

      if (this.isGate()) {
        if (direction === 'close') {
          // the gate has no close command at all — it closes by itself
          throw new Error(this.homey.__('request.gate_auto_close'));
        }
        // resolving is safe here: the committed capability value (not
        // closed) matches the opening/open projection, so no rejection is
        // needed and the Homey app shows no error toast for a gate trigger
        reassertOnRefusal = false;
        return await this._gatePulse();
      }

      if (!this.isManaged()) {
        // flow mode: the throw below is the pending-by-design message, not
        // a refusal — the "Opening…" transient must survive
        reassertOnRefusal = false;
        if (viaCapability) throw new Error(this.homey.__(`request.${direction}`));
        return;
      }

      if (!this._machineState) {
        throw new Error(this.homey.__('request.not_configured'));
      }

      const { state, effects } = StateMachine.request(this._machineState, direction);
      const reject = effects.find(e => e && e.type === 'reject');
      if (reject) {
        throw new Error(this.homey.__(`request.${reject.reason}`));
      }

      reassertOnRefusal = false; // accepted from here on
      this._machineState = state;
      const pulseError = await this._runEffects(effects);
      await this._applyPhase(state.phase);

      if (pulseError) {
        throw new Error(this.homey.__('request.control_failed'));
      }
      if (viaCapability) {
        // reject so Homey does not commit the requested capability value;
        // the message doubles as user feedback in the Homey app
        throw new Error(this.homey.__(direction === 'open' ? 'request.opening' : 'request.closing'));
      }
    } catch (err) {
      if (reassertOnRefusal) this._scheduleCacheReassert();
      throw err;
    }
  }

  /**
   * Whether any Homey user is currently marked present. On lookup failure
   * the request is allowed: a presence hiccup must never lock the user out
   * of their own garage.
   */
  async _someoneIsHome() {
    try {
      const api = await this.homey.app.getApi();
      // $cache: false forces a fresh fetch — the users manager is not
      // connected for realtime updates, so the cached list would keep the
      // presence from the first lookup forever
      const users = Object.values(await api.users.getUsers({ $cache: false }));
      const someoneHome = users.some(user => user.present === true);
      this.log(`presence check: ${users.length} user(s), someone home: ${someoneHome}`);
      return someoneHome;
    } catch (err) {
      this.error('presence check failed, allowing the request', err);
      return true;
    }
  }

  // --------------------------------------------------------------- reports

  /**
   * The "Report the door state" Flow action card. In Flow controlled mode
   * this is the only way the state changes; in Managed mode it acts as an
   * escape hatch that overrides the state machine.
   */
  async setReportedState(state) {
    if (!PHASES.includes(state)) {
      throw new Error(`Unknown garage door state: ${state}`);
    }
    if (this.isGate() && this._gate) {
      this._stopTravelTimer();
      this._gate = { phase: GateMachine.PHASES.includes(state) ? state : 'closed' };
    } else if (this.isManaged() && this._machineState) {
      const result = StateMachine.force(this._machineState, state);
      this._machineState = result.state;
      await this._runEffects(result.effects);
    }
    await this._applyPhase(state);
    this.log(`state reported as ${state}`);
  }

  /**
   * Endpoint-hold projection: while OPENING, garagedoor_closed keeps
   * reading closed until the door actually (or presumably) arrives. With
   * HomeKitty's boolean mapping this is what renders Apple Home's
   * "Opening…" for the whole travel window (target open, current closed);
   * CLOSING already renders "Closing…" because the value stays not-closed
   * until the closed sensor confirms. The gate keeps the plain projection:
   * its capability path commits the requested value on resolve, and its
   * short simulated cycle is the visual feedback.
   */
  _projectClosed(phase) {
    return this.isGate() ? phase === 'closed' : phase === 'closed' || phase === 'opening';
  }

  async _applyPhase(phase) {
    await this.setStoreValue('reportedState', phase);
    await this.setCapabilityValue('garagedoor_state', phase);
    await this.setCapabilityValue('garagedoor_closed', this._projectClosed(phase));
  }

  // ------------------------------------------------------- managed config

  getManagedConfig() {
    return {
      mode: this.getMode(),
      controlDevice: this.getStoreValue('controlDevice'),
      closedSensor: this.getStoreValue('closedSensor'),
      openSensor: this.getStoreValue('openSensor'),
      travelTime: Number(this.getSetting('travel_time')) || 20,
      closedSensorMeaning: this.getSetting('closed_sensor_meaning') || 'default',
      openSensorMeaning: this.getSetting('open_sensor_meaning') || 'default',
      gateOpeningTime: this._gatePhaseSeconds('opening'),
      gateHoldTime: this._gatePhaseSeconds('open'),
      gateClosingTime: this._gatePhaseSeconds('closing'),
    };
  }

  async applyManagedConfig(config) {
    this._teardownManaged();
    await this.setStoreValue('controlDevice', config.controlDevice);
    if (config.mode === 'gate') {
      await this.setStoreValue('closedSensor', null);
      await this.setStoreValue('openSensor', null);
      await this.setSettings({
        gate_opening_time: config.gateOpeningTime,
        gate_hold_time: config.gateHoldTime,
        gate_closing_time: config.gateClosingTime,
      });
      await this._initGate();
      return;
    }
    await this.setStoreValue('closedSensor', config.closedSensor);
    await this.setStoreValue('openSensor', config.openSensor || null);
    await this.setSettings({
      travel_time: config.travelTime,
      closed_sensor_meaning: config.closedSensorMeaning,
      open_sensor_meaning: config.openSensorMeaning,
    });
    await this._initManaged();
  }

};
