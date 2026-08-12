'use strict';

const Homey = require('homey');

module.exports = class VirtualGarageDoorApp extends Homey.App {

  async onInit() {
    this.log('Virtual Garage Door app has been initialized');
  }

};
