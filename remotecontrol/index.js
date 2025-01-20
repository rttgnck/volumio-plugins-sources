'use strict';

const libQ = require('kew');
const io = require('socket.io-client');
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

    this.config = {};
    this.socket = null;
    this.clientInfo = {
      hostname: "RemoteControl",
      uuid: "remoteControl-" + Math.random().toString(36).substring(2, 15)
    };
    
    this.broadcastMessage = this.broadcastMessage.bind(this);
    
    this.logger.info('RemoteControl: Plugin initialized');
  }

  broadcastMessage(emit, payload) {
    this.logger.info('RemoteControl: Broadcast message received:', emit, payload);
    return libQ.resolve();
  }

  onVolumioStart() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    return libQ.resolve();
  }

  onStart() {
    // Initialize WebSocket server and client
    try {
      // Initialize Volumio socket
      this.socket = io.connect('http://localhost:3000', {
        reconnection: true,
        reconnectionDelay: 500,
        reconnectionAttempts: Infinity
      });

      this.socket.on('connect', () => {
        this.logger.info('RemoteControl: Connected to Volumio');
        
        // Initialize our connection
        this.socket.emit('initSocket', this.clientInfo);

        // Get the current state directly from command router first
        let state = this.commandRouter.volumioGetState();
        this.logger.info('RemoteControl: Direct state check:', JSON.stringify(state, null, 2));
        
        // Now get state through socket
        this.socket.emit('getState', '', (state) => {
          if (state) {
            this.logger.info('RemoteControl: Socket state received:', JSON.stringify(state, null, 2));
          } else {
            this.logger.warn('RemoteControl: Received empty state from socket');
          }
        });

        // Get current queue
        this.socket.emit('getQueue', '', (queue) => {
          if (queue && queue.length) {
            this.logger.info('RemoteControl: Queue received with ' + queue.length + ' items');
            this.logger.info('First track:', JSON.stringify(queue[0], null, 2));
          } else {
            this.logger.info('RemoteControl: Queue is empty');
          }
        });
      });

      this.socket.on('disconnect', () => {
        this.logger.info('RemoteControl: Disconnected from Volumio');
      });

      this.initializeStateListeners();



      // Initialize WebSocket server for remote control
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

      return libQ.resolve();
    } catch (error) {
      this.logger.error('RemoteControl: Failed to start:', error);
      return libQ.reject(error);
    }
  }

  initializeStateListeners() {
    // State changes
    this.socket.on('pushState', (state) => {
      if (!state) {
        this.logger.warn('RemoteControl: Received empty state update');
        return;
      }
      
      // Store the current state
      this.state = state;
      
      // Broadcast the state to all connected clients
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
          volume: state.volume
        }
      });
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

    // Add these socket event handlers
    this.socket.on('play', () => {
        this.logger.info('Play command received');
    });

    this.socket.on('pause', () => {
        this.logger.info('Pause command received');
    });

    this.socket.on('stop', () => {
        this.logger.info('Stop command received');
    });

    this.socket.on('prev', () => {
        this.logger.info('Previous command received');
    });

    this.socket.on('next', () => {
        this.logger.info('Next command received');
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
    
    // Parse volume commands that come in format "volume XX"
    if (command.startsWith('volume ')) {
        const volumeLevel = parseInt(command.split(' ')[1]);
        if (!isNaN(volumeLevel)) {
            this.socket.emit('volume', volumeLevel);
            return;
        }
    }
    
    switch (command) {
        case 'toggle':
            if (this.state.status === 'play') {
                this.socket.emit('pause');
            } else {
                this.socket.emit('play');
            }
            break;
        case 'next':
            this.socket.emit('next');
            break;
        case 'previous':
            this.socket.emit('prev');
            break;
        case 'stop':
            this.socket.emit('stop');
            break;
        case 'play':
            this.socket.emit('play');
            break;
        case 'pause':
            this.socket.emit('pause');
            break;
        case 'getState':
            // Send current state back to client
            this.sendCurrentState(this.connectedClients.get(data.token));
            break;
        default:
            if (command.startsWith('seek ')) {
                const seekValue = parseInt(command.split(' ')[1]);
                if (!isNaN(seekValue)) {
                    this.socket.emit('seek', seekValue);
                }
            } else {
                this.logger.warn('RemoteControl: Unknown command:', command);
            }
    }
  }

  onStop() {
    if (this.wsServer) {
      this.wsServer.close();
      this.socket.disconnect();
      this.socket = null;
      this.logger.info('RemoteControl: Plugin stopped');
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

module.exports = RemoteControlPlugin;