'use strict';

module.exports = {
  testEnvironment: 'node',
  clearMocks: true,
  moduleNameMapper: {
    '^homey$': '<rootDir>/test/mocks/homey.js',
  },
  testPathIgnorePatterns: ['/node_modules/', '/\\.homeybuild/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.homeybuild/'],
};
