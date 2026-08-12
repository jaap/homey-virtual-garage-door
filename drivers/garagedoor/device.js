'use strict';

const Homey = require('homey');

const STATES = ['closed', 'opening', 'open', 'closing'];

module.exports = class VirtualGarageDoorDevice extends Homey.Device {

  static STATES = STATES;

  async onInit() {
    if (!this.hasCapability('garagedoor_state')) {
      await this.addCapability('garagedoor_state');
    }

    // Restore the last *reported* state. The store value is only ever
    // written by the report path; the capability values are projections
    // of it, so a restart can never resurrect an unconfirmed request.
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
   * A set on `garagedoor_closed` (the device tile in the Homey app, Apple
   * Home via HomeKitty, or the built-in Open/Close/Toggle Flow cards) is
   * treated as a *request*, never as a state change: emit the matching Flow
   * trigger, then reject so Homey does not commit the unconfirmed value.
   *
   * The rejection is deliberate. HomeKitty swallows it and keeps HomeKit's
   * target state, so Apple Home shows "Opening…"/"Closing…" until a Flow
   * reports the actual state; the Homey app shows the rejection message,
   * which tells the user the request was handed to their Flows.
   */
  async _onGaragedoorClosedRequested(value) {
    const kind = value ? 'close' : 'open';
    this.requestState(kind);
    throw new Error(this.homey.__(`request.${kind}`));
  }

  /**
   * Emit an open/close request to the user's Flows. Used by the capability
   * listener above and by the "Request to open/close" Flow action cards.
   */
  requestState(kind) {
    const trigger = kind === 'close' ? this._closeRequestedTrigger : this._openRequestedTrigger;
    trigger.trigger(this).catch(this.error);
    this.log(`${kind} requested`);
  }

  /**
   * Report path, called by the "Report the door state" Flow action card.
   * This is the only way the state of the virtual garage door changes.
   */
  async setReportedState(state) {
    if (!STATES.includes(state)) {
      throw new Error(`Unknown garage door state: ${state}`);
    }
    await this.setStoreValue('reportedState', state);
    await this._applyReportedState(state);
    this.log(`state reported as ${state}`);
  }

  async _applyReportedState(state) {
    await this.setCapabilityValue('garagedoor_state', state);
    await this.setCapabilityValue('garagedoor_closed', state === 'closed');
  }

};
