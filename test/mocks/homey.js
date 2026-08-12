'use strict';

/**
 * Minimal stand-in for the `homey` module, which only exists on a real Homey.
 * The SDK base classes carry no behavior the app code relies on; every
 * interaction with Homey Core is modeled explicitly in test/helpers.js.
 */
module.exports = {
  App: class App {},
  Driver: class Driver {},
  Device: class Device {},
};
