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
    this.volumioSocket = null;
    this.wsServer = null;
    this.connectedClients = new Map();
    this.state = {};
    
    this.clientInfo = {
      hostname: "VolumioStateTester",
      uuid: "stateTester-" + Math.random().toString(36).substring(2, 15)
    };
    
    this.broadcastMessage = this.broadcastMessage.bind(this);
    
    this.logger.info('VolumioStateTester: Plugin initialized');
  }

  broadcastMessage(emit, payload) {
    this.logger.info('VolumioStateTester: Core broadcast received:', emit, payload);
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
      // First, get the Volumio socket instance directly from commandRouter
      this.volumioSocket = this.commandRouter.volumioGetSocket();
      if (!this.volumioSocket) {
        throw new Error('Failed to get Volumio socket instance');
      }
      this.logger.info('VolumioStateTester: Got Volumio socket instance');

      // Initialize our WebSocket server on the configured port
      const port = this.config.get('port') || 16891;
      this.wsServer = new WebSocket.Server({ port });
      this.logger.info(`VolumioStateTester: WebSocket server created on port ${port}`);

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
                this.broadcastToClients({
                  type: 'state',
                  data: this.state
                });
              }
            } 
            else if (data.type === 'command' && this.connectedClients.has(data.token)) {
              this.handleCommand(data.command);
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

      // Initialize state listeners
      this.initializeStateListeners();

      return libQ.resolve();
    } catch (error) {
      this.logger.error('VolumioStateTester: Failed to start:', error);
      return libQ.reject(error);
    }
  }

  broadcastToClients(message) {
    const messageStr = JSON.stringify(message);
    this.logger.info('VolumioStateTester: Broadcasting to clients:', messageStr);
    
    for (const client of this.connectedClients.values()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  handleCommand(command) {
    this.logger.info('VolumioStateTester: Handling command:', command);
    
    switch (command) {
      case 'toggle':
        this.volumioSocket.emit('play');
        break;
      case 'next':
        this.volumioSocket.emit('next');
        break;
      case 'previous':
        this.volumioSocket.emit('prev');
        break;
      case 'volume_up':
        this.volumioSocket.emit('volume', '+');
        break;
      case 'volume_down':
        this.volumioSocket.emit('volume', '-');
        break;
      default:
        this.logger.warn('VolumioStateTester: Unknown command:', command);
    }
  }

  initializeStateListeners() {
    // State changes
    this.volumioSocket.on('pushState', (state) => {
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

      // Broadcast state to all connected clients
      this.broadcastToClients({
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
    this.volumioSocket.on('volume', (vol) => {
      this.logger.info('VolumioStateTester: Volume Changed to:', vol);
      this.broadcastToClients({
        type: 'volume',
        value: vol
      });
    });

    // Queue changes
    this.volumioSocket.on('pushQueue', (queue) => {
      if (queue && queue.length > 0) {
        this.logger.info('VolumioStateTester: Queue Change Event Received');
        this.broadcastToClients({
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