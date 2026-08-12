'use strict';

const Homey = require('homey');
const { randomUUID } = require('crypto');

module.exports = class VirtualGarageDoorDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    flow.getActionCard('set_state')
      .registerRunListener(async ({ device, state }) => device.setReportedState(state));
    flow.getActionCard('request_open')
      .registerRunListener(async ({ device }) => device.requestState('open'));
    flow.getActionCard('request_close')
      .registerRunListener(async ({ device }) => device.requestState('close'));
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
