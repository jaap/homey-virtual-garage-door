'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

module.exports = class VirtualGarageDoorApp extends Homey.App {

  async onInit() {
    this.log('Virtual Garage Door app has been initialized');
  }

  /**
   * Shared Homey Web API client, created on first use. Requires the
   * `homey:manager:api` permission and is only needed by Managed mode
   * devices, so Flow controlled setups never pay for it.
   */
  async getApi() {
    if (!this._apiPromise) {
      this._apiPromise = HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._apiPromise;
  }

};
