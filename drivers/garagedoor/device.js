'use strict';

const Homey = require('homey');

const STATES = ['closed', 'opening', 'open', 'closing'];

// How long after a request Homey's optimistic capability update is allowed to
// linger before it is reverted to the last reported state. Homey stores the
// requested value as soon as the capability listener resolves; this device
// only accepts state changes that were explicitly reported by a Flow.
const REQUEST_REVERT_MS = 500;

module.exports = class VirtualGarageDoorDevice extends Homey.Device {

  async onInit() {
    // Monotonic counter of received state reports, used to discard the
    // scheduled revert of an optimistic update once a real report arrives.
    this._reportSeq = 0;

    if (!this.hasCapability('garagedoor_state')) {
      await this.addCapability('garagedoor_state');
    }

    // Restore the last *reported* state. Capability values persist across
    // restarts, but the store value is only ever written by the report path,
    // so it cannot contain a half-applied request.
    let state = this.getStoreValue('reportedState');
    if (!STATES.includes(state)) {
      state = this.getCapabilityValue('garagedoor_closed') === false ? 'open' : 'closed';
      await this.setStoreValue('reportedState', state);
    }
    await this._applyReportedState(state);

    this.registerCapabilityListener('garagedoor_closed', this._onGaragedoorClosedRequested.bind(this));

    this._openRequestedTrigger = this.homey.flow.getDeviceTriggerCard('open_requested');
    this._closeRequestedTrigger = this.homey.flow.getDeviceTriggerCard('close_requested');
  }

  /**
   * A set on `garagedoor_closed` (Homey app, Apple Home via HomeKitty, or a
   * standard Flow action card) is treated as a *request*, never as a state
   * change: emit the matching Flow trigger and restore the last reported
   * state shortly after, unless a Flow reported the actual state meanwhile.
   */
  async _onGaragedoorClosedRequested(value) {
    const trigger = value ? this._closeRequestedTrigger : this._openRequestedTrigger;
    trigger.trigger(this).catch(this.error);
    this.log(`${value ? 'close' : 'open'} requested`);

    const seq = this._reportSeq;
    this.homey.setTimeout(() => {
      if (this._reportSeq !== seq) return; // a real report came in, keep it
      const reported = this.getStoreValue('reportedState');
      this.setCapabilityValue('garagedoor_closed', reported === 'closed').catch(this.error);
    }, REQUEST_REVERT_MS);
  }

  /**
   * Report path, called by the "Report the door state" Flow action card.
   * This is the only way the state of the virtual garage door changes.
   */
  async setReportedState(state) {
    if (!STATES.includes(state)) {
      throw new Error(`Unknown garage door state: ${state}`);
    }
    this._reportSeq += 1;
    await this.setStoreValue('reportedState', state);
    await this._applyReportedState(state);
    this.log(`state reported as ${state}`);
  }

  async _applyReportedState(state) {
    await this.setCapabilityValue('garagedoor_state', state);
    await this.setCapabilityValue('garagedoor_closed', state === 'closed');
  }

};
