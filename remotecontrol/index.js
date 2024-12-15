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
      // Get volumio's socket.io instance
      this.socket = this.context.websocketServer;
      
      if (!this.socket) {
        this.logger.error('VolumioStateTester: Failed to get Volumio websocket server');
        return libQ.reject(new Error('Failed to get Volumio websocket server'));
      }

      this.logger.info('VolumioStateTester: Successfully got Volumio websocket server');

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
    // The socket instance from context.websocketServer is the server instance
    // We need to listen for new connections
    this.socket.on('connection', (socket) => {
      this.logger.info('VolumioStateTester: New client connected');

      // State changes (play, pause, etc)
      socket.on('pushState', (state) => {
        this.logger.info('VolumioStateTester: State Change Event Received');
        this.logger.info('State Data:', JSON.stringify(state, null, 2));
      });

      // Queue changes
      socket.on('pushQueue', (queue) => {
        this.logger.info('VolumioStateTester: Queue Change Event Received');
        this.logger.info('Queue Length:', queue.length);
        if (queue && queue.length > 0) {
          this.logger.info('First Track:', JSON.stringify(queue[0], null, 2));
        }
      });

      // Volume changes
      socket.on('volume', (vol) => {
        this.logger.info('VolumioStateTester: Volume Changed to:', vol);
      });

      // Service state updates
      socket.on('serviceUpdateTrackList', (data) => {
        this.logger.info('VolumioStateTester: Service Track List Update:', data);
      });

      // Get initial client state
      socket.emit('getState', '', (state) => {
        this.logger.info('VolumioStateTester: Client initial state:', JSON.stringify(state, null, 2));
      });
    });
  }

  onStop() {
    if (this.socket) {
      this.socket.removeAllListeners('connection');
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