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
    this.clientInfo = {
      hostname: "VolumioStateTester",
      uuid: "stateTester-" + Math.random().toString(36).substring(2, 15)
    };
    
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
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: Infinity
      });

      this.socket.on('connect', () => {
        this.logger.info('VolumioStateTester: Connected to Volumio');
        
        // Initialize our connection
        this.socket.emit('initSocket', this.clientInfo);

        // Get the current state directly from command router first
        let state = this.commandRouter.volumioGetState();
        this.logger.info('VolumioStateTester: Direct state check:', JSON.stringify(state, null, 2));
        
        // Now get state through socket
        this.socket.emit('getState', '', (state) => {
          if (state) {
            this.logger.info('VolumioStateTester: Socket state received:', JSON.stringify(state, null, 2));
          } else {
            this.logger.warn('VolumioStateTester: Received empty state from socket');
          }
        });

        // Get current queue
        this.socket.emit('getQueue', '', (queue) => {
          if (queue && queue.length) {
            this.logger.info('VolumioStateTester: Queue received with ' + queue.length + ' items');
            this.logger.info('First track:', JSON.stringify(queue[0], null, 2));
          } else {
            this.logger.info('VolumioStateTester: Queue is empty');
          }
        });
      });

      this.socket.on('disconnect', () => {
        this.logger.info('VolumioStateTester: Disconnected from Volumio');
      });

      this.initializeStateListeners();

      return libQ.resolve();
    } catch (error) {
      this.logger.error('VolumioStateTester: Failed to start:', error);
      return libQ.reject(error);
    }
  }

  initializeStateListeners() {
    // State changes
    this.socket.on('pushState', (state) => {
      if (!state) {
        this.logger.warn('VolumioStateTester: Received empty state update');
        return;
      }
      
      this.logger.info('VolumioStateTester: State Change Event Received');
      this.logger.info('Status:', state.status);
      this.logger.info('Current Track:', {
        title: state.title,
        artist: state.artist,
        album: state.album,
        duration: state.duration,
        seek: state.seek,
        samplerate: state.samplerate,
        bitdepth: state.bitdepth
      });
      this.logger.info('Volume:', state.volume);
      this.logger.info('Mute:', state.mute);
      this.logger.info('Service:', state.service);
    });

    // Queue changes
    this.socket.on('pushQueue', (queue) => {
      this.logger.info('VolumioStateTester: Queue Change Event Received');
      if (queue && queue.length > 0) {
        this.logger.info('Queue Length:', queue.length);
        this.logger.info('First Track:', {
          name: queue[0].name,
          artist: queue[0].artist,
          album: queue[0].album,
          duration: queue[0].duration,
          service: queue[0].service
        });
      } else {
        this.logger.info('Queue is empty');
      }
    });

    // Volume changes
    this.socket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
    });

    // Seek changes
    this.socket.on('seek', (data) => {
      this.logger.info('VolumioStateTester: Seek Event:', data);
    });

    // Service state updates
    this.socket.on('pushServiceState', (state) => {
      if (!state) {
        this.logger.warn('VolumioStateTester: Received empty service state');
        return;
      }
      this.logger.info('VolumioStateTester: Service State Update:', state);
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