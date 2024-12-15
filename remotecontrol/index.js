// volumio-remotecontrol-plugin/index.js
'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const WebSocket = require('ws');
const crypto = require('crypto');
const SocketIO = require('socket.io-client');

module.exports = RemoteControlPlugin;

function RemoteControlPlugin(context) {
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;
  this.configManager = this.context.configManager;
  this.wsServer = null;
  this.connectedClients = new Map();
  this.state = {}; // Initialize state object
}

RemoteControlPlugin.prototype.onVolumioStart = function() {
  const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  return libQ.resolve();
};

RemoteControlPlugin.prototype.onStart = function() {
  const self = this;
  
  // Initialize Socket.io connection with explicit namespace
  this.socket = SocketIO.connect('http://localhost:3000/push');
  
  // Add connection event handlers for Socket.io
  this.socket.on('connect', () => {
    self.logger.info('RemoteControl: Successfully connected to Volumio websocket');
  });
  
  this.socket.on('disconnect', () => {
    self.logger.info('RemoteControl: Disconnected from Volumio websocket');
  });
  
  this.socket.on('error', (error) => {
    self.logger.error('RemoteControl: Socket.io connection error:', error);
  });

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
  
  // Subscribe to state updates using Socket.io
  this.socket.on('pushState', function(state) {
    self.logger.info('RemoteControl: Received state update:', state);
    if (state) {
      self.state = state; // Update the stored state
      
      // Broadcast to all connected clients
      if (self.wsServer && self.connectedClients.size > 0) {
        const stateMessage = {
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
        };
        
        const messageString = JSON.stringify(stateMessage);
        
        for (const client of self.connectedClients.values()) {
          if (client.readyState === WebSocket.OPEN) {
            try {
              client.send(messageString);
              self.logger.info('RemoteControl: State broadcasted to client');
            } catch (error) {
              self.logger.error('RemoteControl: Error broadcasting state to client:', error);
            }
          }
        }
      }
    }
  });

  return libQ.resolve();
};

RemoteControlPlugin.prototype.sendCurrentState = function(ws) {
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
};

RemoteControlPlugin.prototype.handleClientCommand = function(command) {
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
};

RemoteControlPlugin.prototype.onStop = function() {
  if (this.wsServer) {
    try {
      this.wsServer.close();
      this.logger.info('RemoteControl: WebSocket server stopped');
    } catch (error) {
      this.logger.error('RemoteControl: Error stopping WebSocket server: ' + error);
    }
  }
  
  if (this.socket) {
    this.socket.disconnect();
  }
  
  return libQ.resolve();
};

// Configuration Methods
RemoteControlPlugin.prototype.getUIConfig = function() {
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
};

RemoteControlPlugin.prototype.getConfigurationFiles = function() {
  return ['config.json'];
};