'use strict';

const Homey = require('homey');
const { randomUUID } = require('crypto');

module.exports = class VirtualGarageDoorDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    flow.getActionCard('set_state')
      .registerRunListener(async ({ device, state }) => device.setReportedState(state));
    flow.getActionCard('request_open')
      .registerRunListener(async ({ device }) => device.request('open'));
    flow.getActionCard('request_close')
      .registerRunListener(async ({ device }) => device.request('close'));
  }

  async onPair(session) {
    let pendingConfig = null;

    session.setHandler('get_pair_data', () => this.getPairData());
    session.setHandler('set_managed_config', async config => {
      pendingConfig = this.validateManagedConfig(config);
      return true;
    });
    session.setHandler('list_devices', async () => {
      const device = {
        name: this.homey.__('pair.defaultName'),
        data: { id: randomUUID() },
      };
      if (pendingConfig) {
        device.settings = {
          mode: 'managed',
          travel_time: pendingConfig.travelTime,
          closed_sensor_meaning: pendingConfig.closedSensorMeaning,
          open_sensor_meaning: pendingConfig.openSensorMeaning,
        };
        device.store = {
          controlDevice: pendingConfig.controlDevice,
          closedSensor: pendingConfig.closedSensor,
          openSensor: pendingConfig.openSensor,
        };
      }
      return [device];
    });
  }

  async onRepair(session, device) {
    session.setHandler('get_pair_data', () => this.getPairData());
    session.setHandler('get_current_config', async () => device.getManagedConfig());
    session.setHandler('set_managed_config', async config => {
      await device.applyManagedConfig(this.validateManagedConfig(config));
      return true;
    });
  }

  /**
   * Candidate devices for Managed mode, fetched through the Homey Web API:
   * every other device with a setable `onoff` (control candidates) and
   * every getable boolean capability (sensor candidates).
   */
  async getPairData() {
    const api = await this.homey.app.getApi();
    const devices = Object.values(await api.devices.getDevices());

    const controls = [];
    const sensors = [];

    for (const device of devices) {
      // exclude this app's own virtual doors
      if (typeof device.driverId === 'string' && device.driverId.includes('com.jaap.virtualgaragedoor')) continue;
      const capabilities = device.capabilitiesObj || {};

      for (const [capabilityId, capability] of Object.entries(capabilities)) {
        if (capability.type !== 'boolean') continue;
        if (capabilityId === 'onoff' && capability.setable !== false) {
          controls.push({
            deviceId: device.id,
            name: device.name,
            zone: device.zoneName || '',
          });
        }
        if (capability.getable === false) continue;
        sensors.push({
          deviceId: device.id,
          deviceName: device.name,
          zone: device.zoneName || '',
          capabilityId,
          capabilityTitle: capability.title || capabilityId,
        });
      }
    }

    const byName = key => (a, b) => a[key].localeCompare(b[key]);
    controls.sort(byName('name'));
    sensors.sort(byName('deviceName'));
    return { controls, sensors };
  }

  validateManagedConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    const { controlDevice, closedSensor, openSensor } = config;
    if (!controlDevice || !controlDevice.id) throw new Error('A control device is required');
    if (!closedSensor || !closedSensor.id || !closedSensor.capability) throw new Error('A closed sensor is required');
    if (openSensor && (!openSensor.id || !openSensor.capability)) throw new Error('Invalid open sensor');

    const travelTime = Number(config.travelTime);
    if (!Number.isFinite(travelTime) || travelTime < 5 || travelTime > 120) {
      throw new Error('Travel time must be between 5 and 120 seconds');
    }

    const meaning = value => (value === 'inverted' ? 'inverted' : 'default');
    return {
      controlDevice: { id: controlDevice.id, capability: 'onoff' },
      closedSensor: { id: closedSensor.id, capability: closedSensor.capability },
      openSensor: openSensor ? { id: openSensor.id, capability: openSensor.capability } : null,
      travelTime,
      closedSensorMeaning: meaning(config.closedSensorMeaning),
      openSensorMeaning: meaning(config.openSensorMeaning),
    };
  }

};
