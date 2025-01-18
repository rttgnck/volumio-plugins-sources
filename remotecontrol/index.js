'use strict';

const libQ = require('kew');
const io = require('socket.io-client');
const WebSocket = require('ws');
const crypto = require('crypto');

class VolumioStateTesterPlugin {
  constructor(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.config = {};
    this.socket = null;
    this.wsServer = null;
    this.connectedClients = new Map();
    this.state = {};
    
    this.clientInfo = {
      hostname: "VolumioStateTester",
      uuid: "stateTester-" + Math.random().toString(36).substring(2, 15)
    };
    
    this.broadcastMessage = this.broadcastMessage.bind(this);
    this.handleClientCommand = this.handleClientCommand.bind(this);
    
    this.logger.info('VolumioStateTester: Plugin initialized');
  }

  broadcastMessage(emit, payload) {
    this.logger.info('VolumioStateTester: Core broadcast received:', emit, payload);
    return libQ.resolve();
  }

  broadcastToWebSocketClients(message) {
    const messageStr = JSON.stringify(message);
    this.logger.info('VolumioStateTester: Broadcasting to WebSocket clients:', messageStr);
    
    for (const client of this.connectedClients.values()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  handleClientCommand(command) {
    this.logger.info('VolumioStateTester: Handling command:', command);
    
    switch (command) {
      case 'toggle':
        this.socket.emit('play');
        break;
      case 'next':
        this.socket.emit('next');
        break;
      case 'previous':
        this.socket.emit('prev');
        break;
      case 'volume_up':
        this.socket.emit('volume', '+');
        break;
      case 'volume_down':
        this.socket.emit('volume', '-');
        break;
      default:
        this.logger.warn('VolumioStateTester: Unknown command:', command);
    }
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    try {
      // Initialize WebSocket server first
      const port = this.config.get('port') || 16891;
      this.wsServer = new WebSocket.Server({ port });
      this.logger.info(`VolumioStateTester: WebSocket server created on port ${port}`);
      
      // Connect to Volumio socket (this should use port 3000)
      this.socket = io.connect('http://localhost:3000', {
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: Infinity
      });

      this.socket.on('connect', () => {
        this.logger.info('VolumioStateTester: Connected to Volumio');
        this.socket.emit('initSocket', this.clientInfo);
        this.initializeStateListeners();
      });

      // Set up WebSocket server connection handler
      this.wsServer.on('connection', (ws) => {
        this.logger.info('VolumioStateTester: New client connected');
        
        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message);
            this.logger.info('VolumioStateTester: Received message:', data);
            
            if (data.type === 'register') {
              const token = crypto.randomBytes(32).toString('hex');
              this.connectedClients.set(token, ws);
              ws.send(JSON.stringify({ type: 'registration', token }));
              
              // Send initial state if available
              if (this.state) {
                this.broadcastToWebSocketClients({
                  type: 'state',
                  data: this.state
                });
              }
            } 
            else if (data.type === 'command' && this.connectedClients.has(data.token)) {
              this.handleClientCommand(data.command);
            }
          } catch (error) {
            this.logger.error('VolumioStateTester: Error processing message:', error);
          }
        });
        
        ws.on('close', () => {
          for (const [token, client] of this.connectedClients.entries()) {
            if (client === ws) {
              this.connectedClients.delete(token);
              break;
            }
          }
        });
      });

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
      
      this.state = state;
      this.logger.info('VolumioStateTester: State Change Event Received');
      this.logger.info('Status:', state.status || 'undefined');
      this.logger.info('Current Track:', {
        title: state.title || '',
        artist: state.artist || '',
        album: state.album || '',
        duration: state.duration || 0,
        seek: state.seek || 0,
        samplerate: state.samplerate || '',
        bitdepth: state.bitdepth || ''
      });
      this.logger.info('Volume:', typeof state.volume !== 'undefined' ? state.volume : 'undefined');
      this.logger.info('Mute:', typeof state.mute !== 'undefined' ? state.mute : 'undefined');
      this.logger.info('Service:', state.service || 'undefined');

      // Broadcast state to all connected clients
      this.broadcastToWebSocketClients({
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
    });

    // Volume changes
    this.socket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
      this.broadcastToWebSocketClients({
        type: 'volume',
        value: vol
      });
    });

    // Queue changes
    this.socket.on('pushQueue', (queue) => {
      if (queue && queue.length > 0) {
        this.logger.info('VolumioStateTester: Queue Change Event Received');
        this.broadcastToWebSocketClients({
          type: 'trackChange',
          title: queue[0].name,
          artist: queue[0].artist,
          album: queue[0].album,
          duration: queue[0].duration
        });
      }
    });
  }

  onStop() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    this.logger.info('VolumioStateTester: Plugin stopped');
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