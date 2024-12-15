// volumio-remotecontrol-plugin/index.js
'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const WebSocket = require('ws');
const crypto = require('crypto');

module.exports = RemoteControlPlugin;

function RemoteControlPlugin(context) {
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context.logger;
  this.configManager = this.context.configManager;
  this.wsServer = null;
  this.connectedClients = new Map(); // Store client connections with their tokens
}

RemoteControlPlugin.prototype.onVolumioStart = function() {
  const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  return libQ.resolve();
};

RemoteControlPlugin.prototype.onStart = function() {
  const self = this;
  
  // Initialize WebSocket server
  this.wsServer = new WebSocket.Server({ port: 16891 });
  
  this.wsServer.on('connection', function(ws) {
    self.logger.info('New RemoteControl client connected');
    
    ws.on('message', function(message) {
      try {
        const data = JSON.parse(message);
        self.logger.info('RemoteControl: Received message:', data);
        
        if (data.type === 'register') {
          // Generate unique token for client
          const token = crypto.randomBytes(32).toString('hex');
          self.connectedClients.set(token, ws);
          ws.send(JSON.stringify({ type: 'registration', token: token }));
          self.logger.info('RemoteControl: Client registered with token:', token);
          
          // Send initial state
          self.sendCurrentState(ws);
        } else if (data.type === 'command') {
          // Verify token before processing commands
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
      // Remove client on disconnect
      for (const [token, client] of self.connectedClients.entries()) {
        if (client === ws) {
          self.connectedClients.delete(token);
          self.logger.info('RemoteControl: Client disconnected, token removed:', token);
          break;
        }
      }
    });
  });
  
  // Subscribe to state updates using the correct method
  this.state = this.commandRouter.volumioGetState();
  self.logger.info('RemoteControl: Initial state received:', this.state);

  // Register callback for state changes
  this.commandRouter.addCallback('volumioStateChanged', (state) => {
    this.state = state;
    self.logger.info('RemoteControl: State changed:', state);
    // Broadcast to all connected clients
    for (const client of this.connectedClients.values()) {
      self.logger.info('RemoteControl: Broadcasting state to client');
      this.sendCurrentState(client);
    }
  });

  return libQ.resolve();
};

RemoteControlPlugin.prototype.sendCurrentState = function(ws) {
  const state = this.commandRouter.volumioGetState();
  const response = {
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
  
  ws.send(JSON.stringify(response));
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
    this.wsServer.close();
    this.logger.info('RemoteControl: WebSocket server stopped');
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