'use strict';

const Homey = require('homey');
const { randomUUID } = require('crypto');

/**
 * Shared driver for the three Virtual Garage Door driver types. Subclasses
 * set `static MODE` ('flow' | 'managed' | 'gate') so pairing creates devices
 * of exactly that kind. Flow action cards are app-level and registered once
 * in app.js.
 */
module.exports = class VirtualDoorDriver extends Homey.Driver {

  static MODE = 'flow';

  async onPair(session) {
    let pendingConfig = this.constructor.MODE === 'flow' ? { mode: 'flow' } : null;
    let pendingName = null;

    session.setHandler('set_name', async name => {
      pendingName = this.cleanDeviceName(name);
      return true;
    });
    session.setHandler('get_pair_data', () => this.getPairData());
    session.setHandler('set_managed_config', async config => {
      pendingConfig = this.validateManagedConfig(config);
      return true;
    });
    session.setHandler('set_gate_config', async config => {
      pendingConfig = this.validateGateConfig(config);
      return true;
    });
    session.setHandler('list_devices', async () => [this.buildPairDevice(pendingConfig, pendingName)]);
  }

  async onRepair(session, device) {
    session.setHandler('get_pair_data', () => this.getPairData());
    session.setHandler('get_current_config', async () => device.getManagedConfig());
    session.setHandler('set_managed_config', async config => {
      const validated = config && config.mode === 'gate'
        ? this.validateGateConfig(config)
        : this.validateManagedConfig(config);
      await device.applyManagedConfig(validated);
      return true;
    });
  }

  cleanDeviceName(name) {
    if (typeof name !== 'string') return null;
    const cleaned = name.trim().slice(0, 50);
    return cleaned.length > 0 ? cleaned : null;
  }

  buildPairDevice(config, pendingName = null) {
    const mode = this.constructor.MODE;

    const device = {
      name: this.cleanDeviceName(config && config.name)
        || pendingName
        || this.homey.__(mode === 'gate' ? 'pair.gateName' : 'pair.defaultName'),
      data: { id: randomUUID() },
    };
    if (mode === 'flow' || !config) return device;

    device.store = { controlDevice: config.controlDevice };
    device.settings = {};
    if (mode === 'gate') {
      Object.assign(device.settings, {
        gate_opening_time: config.gateOpeningTime,
        gate_hold_time: config.gateHoldTime,
        gate_closing_time: config.gateClosingTime,
      });
      device.store.closedSensor = null;
      device.store.openSensor = null;
      return device;
    }
    Object.assign(device.settings, {
      travel_time: config.travelTime,
      closed_sensor_meaning: config.closedSensorMeaning,
      open_sensor_meaning: config.openSensorMeaning,
    });
    device.store.closedSensor = config.closedSensor;
    device.store.openSensor = config.openSensor;
    return device;
  }

  /**
   * Candidate devices for Managed/gate configuration, fetched through the
   * Homey Web API: every other device with a setable `onoff` (control
   * candidates) and every getable boolean capability (sensor candidates).
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
      mode: 'managed',
      name: this.cleanDeviceName(config.name),
      controlDevice: { id: controlDevice.id, capability: 'onoff' },
      closedSensor: { id: closedSensor.id, capability: closedSensor.capability },
      openSensor: openSensor ? { id: openSensor.id, capability: openSensor.capability } : null,
      travelTime,
      closedSensorMeaning: meaning(config.closedSensorMeaning),
      openSensorMeaning: meaning(config.openSensorMeaning),
    };
  }

  validateGateConfig(config) {
    if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
    if (!config.controlDevice || !config.controlDevice.id) throw new Error('A control device is required');

    const time = (value, min, max, label) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(`${label} must be between ${min} and ${max} seconds`);
      }
      return parsed;
    };
    return {
      mode: 'gate',
      name: this.cleanDeviceName(config.name),
      controlDevice: { id: config.controlDevice.id, capability: 'onoff' },
      gateOpeningTime: time(config.gateOpeningTime, 1, 300, 'Opening time'),
      gateHoldTime: time(config.gateHoldTime, 1, 600, 'Open time'),
      gateClosingTime: time(config.gateClosingTime, 1, 300, 'Closing time'),
    };
  }

};
