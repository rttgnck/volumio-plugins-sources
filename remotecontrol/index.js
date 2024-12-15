'use strict';

const libQ = require('kew');
const fs = require('fs-extra');

class VolumioStateTesterPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    
    // Get socket.io instance
    this.volumioSocket = null;
    
    this.logger.info('VolumioStateTester: Plugin initialized');
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    // Get volumio socket instance
    this.volumioSocket = this.commandRouter.volumioGetSocket();
    if (!this.volumioSocket) {
      this.logger.error('VolumioStateTester: Failed to get Volumio socket instance');
      return libQ.reject(new Error('Failed to get Volumio socket'));
    }

    this.logger.info('VolumioStateTester: Successfully connected to Volumio socket');

    // Initialize state event listeners
    this.initializeStateListeners();

    return libQ.resolve();
  }

  initializeStateListeners() {
    // Volume changes
    this.volumioSocket.on('volume', (data) => {
      this.logger.info('VolumioStateTester: Volume Event Received');
      this.logger.info('Volume Data:', JSON.stringify(data, null, 2));
    });

    // State changes (play, pause, etc)
    this.volumioSocket.on('pushState', (state) => {
      this.logger.info('VolumioStateTester: State Change Event Received');
      this.logger.info('State Data:', JSON.stringify(state, null, 2));
    });

    // Queue changes
    this.volumioSocket.on('pushQueue', (queue) => {
      this.logger.info('VolumioStateTester: Queue Change Event Received');
      this.logger.info('Queue Data:', JSON.stringify(queue, null, 2));
    });

    // Seek changes
    this.volumioSocket.on('seek', (data) => {
      this.logger.info('VolumioStateTester: Seek Event Received');
      this.logger.info('Seek Data:', JSON.stringify(data, null, 2));
    });

    // Service updates
    this.volumioSocket.on('serviceUpdate', (data) => {
      this.logger.info('VolumioStateTester: Service Update Event Received');
      this.logger.info('Service Data:', JSON.stringify(data, null, 2));
    });

    // Track info changes
    this.volumioSocket.on('trackInfo', (data) => {
      this.logger.info('VolumioStateTester: Track Info Event Received');
      this.logger.info('Track Info:', JSON.stringify(data, null, 2));
    });
  }

  onStop() {
    // Clean up listeners if needed
    if (this.volumioSocket) {
      this.volumioSocket.off('volume');
      this.volumioSocket.off('pushState');
      this.volumioSocket.off('pushQueue');
      this.volumioSocket.off('seek');
      this.volumioSocket.off('serviceUpdate');
      this.volumioSocket.off('trackInfo');
    }
    return libQ.resolve();
  }

  getConfigurationFiles() {
    return ['config.json'];
  }
}

module.exports = VolumioStateTesterPlugin;