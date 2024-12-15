'use strict';

const libQ = require('kew');

class VolumioStateTesterPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.config = {};
    
    // Required for plugin interface
    this.broadcastMessage = this.broadcastMessage.bind(this);
    
    this.logger.info('VolumioStateTester: Plugin initialized');
  }

  broadcastMessage(emit, payload) {
    this.logger.info('VolumioStateTester: Broadcast message received:', emit, payload);
    return libQ.resolve();
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    try {
      // Get volumio socket instance
      this.socket = this.commandRouter.volumioGetSocket();
      
      if (!this.socket) {
        this.logger.error('VolumioStateTester: Failed to get Volumio socket');
        return libQ.reject(new Error('Failed to get Volumio socket'));
      }

      this.logger.info('VolumioStateTester: Successfully got Volumio socket');

      // Request initial state
      const state = this.commandRouter.volumioGetState();
      this.logger.info('VolumioStateTester: Initial state:', JSON.stringify(state, null, 2));
      
      // Initialize state event listeners
      this.initializeStateListeners();

      return libQ.resolve();
    } catch (error) {
      this.logger.error('VolumioStateTester: Failed to start:', error);
      return libQ.reject(error);
    }
  }

  initializeStateListeners() {
    // State changes (play, pause, etc)
    this.socket.on('pushState', (state) => {
      this.logger.info('VolumioStateTester: State Change Event Received');
      this.logger.info('State Data:', JSON.stringify(state, null, 2));
    });

    // Queue changes
    this.socket.on('pushQueue', (queue) => {
      this.logger.info('VolumioStateTester: Queue Change Event Received');
      this.logger.info('Queue Length:', queue.length);
      if (queue && queue.length > 0) {
        this.logger.info('First Track:', JSON.stringify(queue[0], null, 2));
      }
    });

    // Volume changes
    this.socket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
    });

    // Service state updates
    this.socket.on('serviceUpdateTrackList', (data) => {
      this.logger.info('VolumioStateTester: Service Track List Update:', data);
    });

    // Multiroom updates
    this.socket.on('pushMultiRoomDevices', (data) => {
      this.logger.info('VolumioStateTester: Multiroom Devices Update:', JSON.stringify(data, null, 2));
    });
  }

  onStop() {
    if (this.socket) {
      // Remove our listeners but don't disconnect the socket
      this.socket.removeAllListeners('pushState');
      this.socket.removeAllListeners('pushQueue');
      this.socket.removeAllListeners('volume');
      this.socket.removeAllListeners('serviceUpdateTrackList');
      this.socket.removeAllListeners('pushMultiRoomDevices');
      this.logger.info('VolumioStateTester: Removed all listeners');
    }
    return libQ.resolve();
  }

  getConfigurationFiles() {
    return ['config.json'];
  }

  // Required methods for Volumio plugin interface
  getUIConfig() {
    return libQ.resolve({});
  }

  setUIConfig(data) {
    return libQ.resolve();
  }

  getConf(varName) {
    return this.config.get(varName);
  }

  setConf(varName, varValue) {
    this.config.set(varName, varValue);
  }
}

module.exports = VolumioStateTesterPlugin;