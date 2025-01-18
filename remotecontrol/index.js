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
    this.state = {};
    
    // Get socket.io instance
    this.volumioSocket = null;
    
    // Bind methods
    this.onVolumeChange = this.onVolumeChange.bind(this);
    this.onPlaybackStateChange = this.onPlaybackStateChange.bind(this);
    this.onQueueChange = this.onQueueChange.bind(this);
    this.initializeListeners = this.initializeListeners.bind(this);
    
    this.logger.info('RemoteControl: Plugin initialized');
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    // Get volumio socket instance
    this.volumioSocket = this.commandRouter.volumioGetSocket();
    if (!this.volumioSocket) {
      this.logger.error('RemoteControl: Failed to get Volumio socket instance');
      return libQ.reject(new Error('Failed to get Volumio socket'));
    }

    // Initialize WebSocket server
    try {
      this.wsServer = new WebSocket.Server({ port: 16891 });
      this.logger.info('RemoteControl: WebSocket server created on port 16891');
      
      this.wsServer.on('connection', (ws) => {
        this.logger.info('RemoteControl: New client connected');
        
        ws.on('message', (message) => {
          try {
            const data = JSON.parse(message);
            this.logger.info('RemoteControl: Received message:', data);
            
            if (data.type === 'register') {
              const token = crypto.randomBytes(32).toString('hex');
              this.connectedClients.set(token, ws);
              ws.send(JSON.stringify({ type: 'registration', token }));
              
              // Send initial state
              this.sendCurrentState(ws);
            } 
            else if (data.type === 'command' && this.connectedClients.has(data.token)) {
              this.handleClientCommand(data.command);
            }
          } catch (error) {
            this.logger.error('RemoteControl: Error processing message:', error);
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

      // Initialize Volumio event listeners
      this.initializeListeners();

    } catch (error) {
      this.logger.error('RemoteControl: Failed to start:', error);
      return libQ.reject(error);
    }

    return libQ.resolve();
  }

  initializeListeners() {
    // Volume changes
    this.volumioSocket.on('volume', (data) => {
      this.logger.info('RemoteControl: Volume changed:', data);
      this.broadcastToClients({
        type: 'volume',
        value: data
      });
    });

    // State changes
    this.volumioSocket.on('pushState', (state) => {
      this.logger.info('RemoteControl: State changed:', state);
      this.state = state;
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

    // Queue changes
    this.volumioSocket.on('pushQueue', (queue) => {
      this.logger.info('RemoteControl: Queue changed:', queue);
      if (queue && queue.length > 0) {
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

  broadcastToClients(message) {
    const messageStr = JSON.stringify(message);
    this.logger.info('RemoteControl: Broadcasting to clients:', messageStr);
    
    for (const client of this.connectedClients.values()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

  sendCurrentState(ws) {
    if (!this.state) return;
    
    try {
      const message = JSON.stringify({
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
      });
      
      ws.send(message);
    } catch (error) {
      this.logger.error('RemoteControl: Error sending state:', error);
    }
  }

  handleClientCommand(command) {
    this.logger.info('RemoteControl: Handling command:', command);
    
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
        this.logger.warn('RemoteControl: Unknown command:', command);
    }
  }

  onStop() {
    if (this.wsServer) {
      this.wsServer.close();
    }
    return libQ.resolve();
  }

  getConfigurationFiles() {
    return ['config.json'];
  }
}

module.exports = RemoteControlPlugin;