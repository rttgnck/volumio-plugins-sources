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
      this.socket = io.connect('http://localhost:3000', {
      //   reconnection: true,
      //   reconnectionDelay: 500,
      //   reconnectionAttempts: Infinity
      // });
      // this.socket = socketio('http://localhost:3000', {
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
        
        // First send init socket with our client info
        this.socket.emit('initSocket', {
          "hostname": "VolumioStateTester",
          "uuid": "stateTester-" + Math.random().toString(36).substring(2, 15)
        });

        // Then register for events
        this.socket.emit('registerConfigCallback', {
          "name": "VolumioStateTester",
          "callback": "stateCallback"
        });

        // Now request initial state
        this.socket.emit('getState', '', (state) => {
          this.logger.info('VolumioStateTester: Initial state received:', JSON.stringify(state, null, 2));
        });

        // And request queue state
        this.socket.emit('getQueue', '', (queue) => {
          this.logger.info('VolumioStateTester: Initial queue received:', JSON.stringify(queue, null, 2));
        });
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
    // State changes (play, pause, etc)
    this.socket.on('pushState', (state) => {
      this.logger.info('VolumioStateTester: State Change Event Received');
      this.logger.info('State Data:', JSON.stringify(state, null, 2));
    });

    // Queue changes
    this.socket.on('pushQueue', (queue) => {
      this.logger.info('VolumioStateTester: Queue Change Event Received');
      if (queue && queue.length > 0) {
        this.logger.info('Queue Data:', JSON.stringify(queue, null, 2));
      }
    });

    // Volume changes
    this.socket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
    });

    // Service updates
    this.socket.on('pushServiceState', (state) => {
      this.logger.info('VolumioStateTester: Service State Update:', state);
    });

    // Handle config callbacks
    this.socket.on('stateCallback', (data) => {
      this.logger.info('VolumioStateTester: State Callback:', data);
    });
  }

  onStop() {
    if (this.socket) {
      // Unregister first
      this.socket.emit('unregisterConfigCallback', {
        "name": "VolumioStateTester",
        "callback": "stateCallback"
      });
      
      // Then disconnect
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