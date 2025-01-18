// volumio-remotecontrol-plugin/index.js
'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const WebSocket = require('ws');
const crypto = require('crypto');

class RemoteControlPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;
    this.wsServer = null;
    this.connectedClients = new Map();
    this.state = {}; // Initialize state object

    // Bind methods to preserve 'this' context
    this.onVolumeChange = this.onVolumeChange.bind(this);
    this.onPlaybackStateChange = this.onPlaybackStateChange.bind(this);
    this.onTrackChange = this.onTrackChange.bind(this);
    // this.initializeListeners = this.initializeListeners.bind(this);
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    const self = this;

    // Initialize state listeners
    // this.initializeListeners();

    // Initialize WebSocket server with error handling
    try {
      this.wsServer = new WebSocket.Server({ port: 16891 });
      
      this.wsServer.on('connection', function(ws) {
        self.logger.info('New RemoteControl client connected');
        
        ws.on('message', function(message) {
          try {
            const data = JSON.parse(message);
            self.logger.info('RemoteControl: Received message:', data);
            
            if (data.type === 'register') {
              const token = crypto.randomBytes(32).toString('hex');
              self.connectedClients.set(token, ws);
              const response = { type: 'registration', token: token };
              ws.send(JSON.stringify(response));
              self.logger.info(`RemoteControl: Client registered with token: ${token}`);
              
              // Send initial state
              self.sendCurrentState(ws);
            } else if (data.type === 'command') {
              if (self.connectedClients.has(data.token)) {
                self.logger.info('RemoteControl: Processing command:', data.command);
                self.handleClientCommand(data.command);
              } else {
                self.logger.warn('RemoteControl: Invalid token received:', data.token);
              }
            }
          } catch (error) {
            self.logger.error('RemoteControl: Error processing message: ' + error);
          }
        });
        
        ws.on('close', function() {
          for (const [token, client] of self.connectedClients.entries()) {
            if (client === ws) {
              self.connectedClients.delete(token);
              self.logger.info('RemoteControl: Client disconnected, token removed:', token);
              break;
            }
          }
        });
      });

      this.wsServer.on('error', function(error) {
        if (error.code === 'EADDRINUSE') {
          self.logger.error('RemoteControl: WebSocket port 16891 is already in use');
          self.wsServer = null;
        } else {
          self.logger.error('RemoteControl: WebSocket server error: ' + error);
        }
      });
      
    } catch (error) {
      self.logger.error('RemoteControl: Failed to start WebSocket server: ' + error);
      this.wsServer = null;
    }

    return libQ.resolve();
  }

  // // Initialize all state listeners
  // initializeListeners() {
  //   // Get the Volumio socket.io instance
  //   const io = this.commandRouter.volumioGetSocket();

  //   // Listen for volume changes
  //   io.on('volume', this.onVolumeChange);

  //   // Listen for play state changes  
  //   io.on('pushState', this.onPlaybackStateChange);

  //   // Listen for track changes
  //   io.on('queue', this.onTrackChange);
  // }

  // Handle volume changes
  onVolumeChange(data) {
    if (this.wsServer && this.connectedClients.size > 0) {
      const message = JSON.stringify({
        type: 'volume',
        value: data
      });

      for (const client of this.connectedClients.values()) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }

  // Handle playback state changes (play/pause/stop)
  onPlaybackStateChange(state) {
    this.state = state;
    if (this.wsServer && this.connectedClients.size > 0) {
      const message = JSON.stringify({
        type: 'state',
        data: {
          status: state.status,
          title: state.title,
          artist: state.artist,
          album: state.album,
          albumart: state.albumart,
          duration: state.duration,
          seek: state.seek,
          samplerate: state.samplerate,
          bitdepth: state.bitdepth,
          trackType: state.trackType,
          volume: state.volume
        }
      });

      for (const client of this.connectedClients.values()) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }

  // Handle track changes
  onTrackChange(queue) {
    if (!queue || !queue.length) return;
    
    const currentTrack = queue[0];
    if (this.wsServer && this.connectedClients.size > 0) {
      const message = JSON.stringify({
        type: 'trackChange',
        title: currentTrack.name,
        artist: currentTrack.artist,
        album: currentTrack.album,
        duration: currentTrack.duration
      });

      for (const client of this.connectedClients.values()) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      }
    }
  }

  sendCurrentState(ws) {
    if (!this.state) {
      this.logger.warn('RemoteControl: No state available to send');
      return;
    }
    
    const response = {
      type: 'state',
      data: {
        status: this.state.status,
        title: this.state.title,
        artist: this.state.artist,
        album: this.state.album,
        albumart: this.state.albumart,
        duration: this.state.duration,
        seek: this.state.seek,
        samplerate: this.state.samplerate,
        bitdepth: this.state.bitdepth,
        trackType: this.state.trackType,
        volume: this.state.volume
      }
    };
    
    try {
      ws.send(JSON.stringify(response));
      this.logger.info('RemoteControl: Sent current state to client');
    } catch (error) {
      this.logger.error('RemoteControl: Error sending current state:', error);
    }
  }

  handleClientCommand(command) {
    switch (command) {
      case 'toggle':
        this.commandRouter.volumioToggle();
        break;
      case 'next':
        this.commandRouter.volumioNext();
        break;
      case 'previous':
        this.commandRouter.volumioPrevious();
        break;
      case 'volume_up':
        this.commandRouter.volumioVolume('+');
        break;
      case 'volume_down':
        this.commandRouter.volumioVolume('-');
        break;
      default:
        this.logger.warn('RemoteControl: Unknown command received: ' + command);
        break;
    }
  }

  onStop() {
    if (this.wsServer) {
      try {
        this.wsServer.close();
        this.logger.info('RemoteControl: WebSocket server stopped');
      } catch (error) {
        this.logger.error('RemoteControl: Error stopping WebSocket server: ' + error);
      }
    }
    
    return libQ.resolve();
  }

  // Configuration Methods
  getUIConfig() {
    const defer = libQ.defer();
    const self = this;

    const lang_code = self.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
      __dirname + '/i18n/strings_en.json',
      __dirname + '/UIConfig.json')
      .then((uiconf) => {
        defer.resolve(uiconf);
      })
      .fail((error) => {
        defer.reject(new Error());
      });

    return defer.promise;
  }

  getConfigurationFiles() {
    return ['config.json'];
  }
}

module.exports = RemoteControlPlugin;