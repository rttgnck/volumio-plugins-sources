'use strict';

const libQ = require('kew');
const io = require('socket.io-client');

class VolumioStateTesterPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.socket = null;
    
    this.logger.info('VolumioStateTester: Plugin initialized');
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    try {
      // Connect directly to Volumio's socket.io server
      this.socket = io('http://localhost:3000');
      
      // Connection events
      this.socket.on('connect', () => {
        this.logger.info('VolumioStateTester: Successfully connected to Volumio socket.io server');
        
        // Request initial state once connected
        this.socket.emit('getState', '', (state) => {
          this.logger.info('VolumioStateTester: Initial state received:', JSON.stringify(state, null, 2));
        });
      });

      this.socket.on('connect_error', (error) => {
        this.logger.error('VolumioStateTester: Connection error:', error);
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
      this.logger.info('Queue Length:', queue.length);
      if (queue.length > 0) {
        this.logger.info('First Track:', JSON.stringify(queue[0], null, 2));
      }
    });

    // Volume changes
    this.socket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
    });

    // Test emit (based on the community thread example)
    setInterval(() => {
      this.socket.emit('getState', '', (state) => {
        this.logger.info('VolumioStateTester: Periodic state check:', JSON.stringify(state, null, 2));
      });
    }, 5000); // Check every 5 seconds
  }

  onStop() {
    if (this.socket) {
      this.logger.info('VolumioStateTester: Disconnecting socket');
      this.socket.disconnect();
    }
    return libQ.resolve();
  }

  getConfigurationFiles() {
    return ['config.json'];
  }
}

module.exports = VolumioStateTesterPlugin;