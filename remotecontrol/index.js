'use strict';

const libQ = require('kew');
const io = require('socket.io-client');

class VolumioStateTesterPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.config = {};
    this.socket = null;
    
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
      // Connect to Volumio's socket as a client
      this.socket = io.connect('http://localhost:3000');
      
      this.socket.on('connect', () => {
        this.logger.info('VolumioStateTester: Successfully connected to Volumio websocket');
        
        // Get initial state
        this.socket.emit('getState', '', (state) => {
          this.logger.info('VolumioStateTester: Initial state:', JSON.stringify(state, null, 2));
        });

        // Get current queue
        this.socket.emit('getQueue', '', (queue) => {
          this.logger.info('VolumioStateTester: Initial queue:', JSON.stringify(queue, null, 2));
        });
      });

      this.socket.on('connect_error', (err) => {
        this.logger.error('VolumioStateTester: Connection error:', err);
      });

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
      this.logger.info('Queue Data:', JSON.stringify(queue, null, 2));
    });

    // Volume changes
    this.socket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
    });

    // Seek changes
    this.socket.on('seek', (data) => {
      this.logger.info('VolumioStateTester: Seek Event:', data);
    });
  }

  onStop() {
    if (this.socket) {
      this.socket.disconnect();
      this.logger.info('VolumioStateTester: Disconnected from Volumio websocket');
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