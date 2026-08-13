'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

module.exports = class VirtualGarageDoorApp extends Homey.App {

  async onInit() {
    // The flow cards are app-level and shared by all three driver types;
    // their device argument routes each run to the right device.
    const { flow } = this.homey;
    flow.getActionCard('set_state')
      .registerRunListener(async ({ device, state }) => device.setReportedState(state));
    flow.getActionCard('request_open')
      .registerRunListener(async ({ device }) => device.request('open'));
    flow.getActionCard('request_close')
      .registerRunListener(async ({ device }) => device.request('close'));

    this.log('Virtual Garage Door app has been initialized');
  }

  /**
   * Shared Homey Web API client, created on first use. Requires the
   * `homey:manager:api` permission; used by Managed/gate devices and by
   * the only-open-when-home presence check.
   */
  async getApi() {
    if (!this._apiPromise) {
      this._apiPromise = HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._apiPromise;
  }

};
