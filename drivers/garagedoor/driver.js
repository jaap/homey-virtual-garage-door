'use strict';

const Homey = require('homey');
const { randomUUID } = require('crypto');

module.exports = class VirtualGarageDoorDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow
      .getActionCard('set_state')
      .registerRunListener(async ({ device, state }) => device.setReportedState(state));
  }

  async onPairListDevices() {
    // Nothing to discover: offer a single new virtual device per pairing session.
    return [
      {
        name: this.homey.__('pair.defaultName'),
        data: { id: randomUUID() },
      },
    ];
  }

};
