'use strict';

const libQ = require('kew');
const socketio = require('socket.io-client');

class VolumioStateTesterPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.config = {};
    this.socket = null;
    
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
      // Use socket.io-client with matching configuration
      this.socket = socketio('http://localhost:3000', {
        perMessageDeflate: false,
        maxHttpBufferSize: 1e7,
        transports: ['websocket', 'polling'],
        // Force same version as server
        forceNew: true,
        timeout: 5000,
        // Match server configuration
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5
      });

      this.socket.on('connect', () => {
        this.logger.info('VolumioStateTester: Connected to Volumio');
        
        // Notify volumio about this connection
        this.socket.emit('initSocket');
        
        // Get current state
        this.socket.emit('getState');
      });

      this.socket.on('disconnect', () => {
        this.logger.info('VolumioStateTester: Disconnected from Volumio');
      });

      this.socket.on('error', (err) => {
        this.logger.error('VolumioStateTester: Socket error:', err);
      });

      this.socket.on('connect_error', (err) => {
        this.logger.error('VolumioStateTester: Connection error:', err);
      });

      this.initializeStateListeners();

      return libQ.resolve();
    } catch (error) {
      this.logger.error('VolumioStateTester: Failed to start:', error);
      return libQ.reject(error);
    }
  }

  initializeStateListeners() {
    // State updates
    this.socket.on('pushState', (state) => {
      this.logger.info('VolumioStateTester: State update:', JSON.stringify(state, null, 2));
    });

    // Volume changes
    this.socket.on('pushVolume', (volume) => {
      this.logger.info('VolumioStateTester: Volume changed:', volume);
    });

    // Queue updates
    this.socket.on('pushQueue', (queue) => {
      this.logger.info('VolumioStateTester: Queue update. Number of tracks:', queue ? queue.length : 0);
    });
  }

  onStop() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.logger.info('VolumioStateTester: Plugin stopped');
    }
    return libQ.resolve();
  }

  getConfigurationFiles() {
    return ['config.json'];
  }

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