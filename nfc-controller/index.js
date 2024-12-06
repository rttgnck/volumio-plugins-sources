'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const io = require('socket.io-client');
const socket = io.connect('http://localhost:3000');
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;

const NFCDaemon = require('./lib/nfcDaemon');
const getTokenManager = require('./lib/getTokenManager');

const MY_LOG_NAME = 'NFC Controller plugin';

module.exports = NFCController;

function NFCController(context) {
    const self = this;
    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.configManager = self.context.configManager;
    
    // From original NFCReader
    self.tokenManager = getTokenManager(self.logger);
}


NFCController.prototype.onVolumioStart = function() {
    const self = this;
    
    const configFile = self.commandRouter.pluginManager.getConfigurationFile(self.context, 'config.json');
    self.config = new (require('v-conf'))();
    self.config.loadFile(configFile);
    
    self.logger.info("NFCController initialized");
    
    return libQ.resolve();
};

NFCController.prototype.getConfigurationFiles = function() {
    return ['config.json'];
};

NFCController.prototype.onStart = function() {
    const self = this;
    const defer = libQ.defer();

    // Add direct socket event listener for callMethod
    socket.on('callMethod', function(data) {
        self.logger.info('callMethod received:', JSON.stringify(data));
        
        if (data.endpoint === 'user_interface/nfc-controller') {
            switch (data.method) {
                case 'assignPlaylist':
                    self.logger.info('Calling assignPlaylist with:', JSON.stringify(data.data));
                    self.assignPlaylist(data.data);
                    break;
                case 'savePlaybackOptions':
                    self.logger.info('Calling savePlaybackOptions with:', JSON.stringify(data.data));
                    self.savePlaybackOptions(data.data);
                    break;
                case 'saveTechConfiguration':
                    self.logger.info('Calling saveTechConfiguration with:', JSON.stringify(data.data));
                    self.saveTechConfiguration(data.data);
                    break;
                default:
                    self.logger.warn('Unknown method called:', data.method);
            }
        }
    });

    // Register callback to sniff which playlist is currently playing
    socket.on('playingPlaylist', function(playlist) {
        self.currentPlaylist = playlist;
        self.logger.info('Currently playing playlist', self.currentPlaylist);
    });

    // Configuration default values
	if (!self.config.get('pollingRate')) {
		self.config.set('pollingRate', 1000); // Changed from 500 to 1000
	}

    if (!self.config.get('debounceThreshold')) {
        self.config.set('debounceThreshold', 1);
    }

    // Start the NFC daemon
    self.registerWatchDaemon()
        .then(function() {
            self.logger.info("NFCController started");
            defer.resolve();
        })
        .catch(function(err) {
            self.logger.error("Failed to start NFCController:", err);
            defer.reject(err);
        });
    
    return defer.promise;
};

NFCController.prototype.onStop = function() {
    const self = this;
    const defer = libQ.defer();

    self.commandRouter.unregisterHandler('user_interface/nfc-controller');

    self.unRegisterWatchDaemon()
        .then(function() {
            self.logger.info("NFCController stopped");
            defer.resolve();
        });

    socket.removeAllListeners();

    return defer.promise;
};

NFCController.prototype.onRestart = function() {
    const self = this;
    self.unRegisterWatchDaemon()
        .then(() => self.registerWatchDaemon());
};

NFCController.prototype.getUIConfig = function() {
    const defer = libQ.defer();
    const self = this;

    self.logger.info(MY_LOG_NAME, 'Getting UI config');

    const lang_code = self.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function(uiconf) {
            const unassignSection = uiconf.sections[1];
            const techSection = uiconf.sections[3];
            const playlistSelectBox = uiconf.sections[0].content[0];

            // Technical Reader settings
            techSection.content[0].value.value = self.config.get('spi');
            techSection.content[1].value = self.config.get('pollingRate');
            techSection.content[2].value = self.config.get('debounceThreshold');

            // Dynamically add playlist-related information
            socket.emit('listPlaylist');
            socket.once('pushListPlaylist', (playlists) => {
                playlists.map((playlist) => {
                    playlistSelectBox.options.push({ value: playlist, label: playlist });
                });

                if (self.currentPlaylist) {
                    playlistSelectBox.value.value = self.currentPlaylist;
                    playlistSelectBox.value.label = self.currentPlaylist;
                }

                // Create elements for all assignments
                self.tokenManager.getAllAssignments().map((assignment) => {
                    self.logger.info('Found assignment', JSON.stringify(assignment));

                    unassignSection.content.push({
                        "id": `unassign_${assignment.uid}`,
                        "element": "button",
                        "label": `${assignment.data}`,
                        "onClick": {
                            "type": "emit",
                            "message": "callMethod",
                            "data": {
                                "endpoint": "user_interface/nfc-controller",
                                "method": "unassignToken",
                                "data": assignment.uid
                            }
                        }
                    });
                });
                
                defer.resolve(uiconf);
            });
        })
        .fail(function() {
            defer.reject(new Error());
        });

    return defer.promise;
};

NFCController.prototype.saveTechConfiguration = function(data) {
    const self = this;

    self.logger.info(MY_LOG_NAME, 'Saving config', JSON.stringify(data));

    self.config.set('spi', data.spi.value);
    self.config.set('pollingRate', data.pollingRate);
    self.config.set('debounceThreshold', data.debounceThreshold);

    self.commandRouter.pushToastMessage('success', MY_LOG_NAME, "Configuration saved");

    self.unRegisterWatchDaemon()
        .then(() => self.registerWatchDaemon());
};

NFCController.prototype.savePlaybackOptions = function(data) {
    const self = this;

    self.logger.info(MY_LOG_NAME, 'Saving config', JSON.stringify(data));

    self.config.set('stopWhenRemoved', data.stopWhenRemoved);

    self.commandRouter.pushToastMessage('success', MY_LOG_NAME, "Configuration saved");
};

NFCController.prototype.handleTokenDetected = function(uid) {
    const self = this;
    self.currentTokenUid = uid;
    self.logger.info('NFC card detected', self.currentTokenUid);

    socket.emit('getState', '');
    socket.once('pushState', () => {
        const playlist = self.tokenManager.readToken(self.currentTokenUid);

        self.logger.info(`${MY_LOG_NAME} requesting to play playlist`, playlist);

        if (playlist) {
            self.commandRouter.pushToastMessage('success', MY_LOG_NAME, `requesting to play playlist ${playlist}`);
        } else {
            self.commandRouter.pushToastMessage('success', MY_LOG_NAME, `An unassigned token (UID ${uid}) has been detected`);
        }

        if (playlist && playlist !== self.currentPlaylist) {
            socket.emit('playPlaylist', {
                "name": playlist
            });
        }
    });
};

NFCController.prototype.handleTokenRemoved = function(uid) {
    const self = this;
    self.currentTokenUid = null;
    self.logger.info('NFC card removed', uid);

    if (self.config.get('stopWhenRemoved')) {
        socket.emit('getState', '');
        socket.once('pushState', (state) => {
            if (state.status == 'play' && state.service == 'webradio') {
                socket.emit('stop');
            } else {
                socket.emit('pause');
            }
        });
    }
};

NFCController.prototype.registerWatchDaemon = async function() {
    const self = this;

    self.logger.info(`${MY_LOG_NAME} Registering a thread to poll the NFC reader`);

    // Use i2c bus 1 by default
    const i2cBusNumber = 1;
    const pollingRate = self.config.get('pollingRate');
    const debounceThreshold = self.config.get('debounceThreshold');

    self.logger.info(MY_LOG_NAME, 'i2c bus number', i2cBusNumber);
    self.logger.info(MY_LOG_NAME, 'polling rate', pollingRate);
    self.logger.info(MY_LOG_NAME, 'debounce threshold', debounceThreshold);

    self.nfcDaemon = new NFCDaemon(
        i2cBusNumber,
        self.handleTokenDetected.bind(self),
        self.handleTokenRemoved.bind(self),
        self.logger,
        pollingRate,
        debounceThreshold
    );

    try {
        const started = await self.nfcDaemon.start();
        if (!started) {
            self.logger.error(`${MY_LOG_NAME}: Failed to start NFC daemon`);
            return libQ.reject(new Error('Failed to start NFC daemon'));
        }
        return libQ.resolve();
    } catch (err) {
        self.logger.error(`${MY_LOG_NAME}: Error starting NFC daemon:`, err);
        return libQ.reject(err);
    }
};

NFCController.prototype.unRegisterWatchDaemon = function() {
    const self = this;
    const defer = libQ.defer();

    self.logger.info(`${MY_LOG_NAME}: Stopping NFC daemon`);
    if (self.nfcDaemon) {
        self.nfcDaemon.stop();
        self.nfcDaemon = null;
    }
    defer.resolve();
    return defer.promise;
};

NFCController.prototype.assignPlaylist = function({ playlist }) {
    const self = this;
    const effectivePlaylist = playlist.value || self.currentPlaylist;
    self.logger.info('assignPlaylist called with data:', JSON.stringify(playlist));
    self.commandRouter.pushToastMessage('success', MY_LOG_NAME, `Assigning playlist ${effectivePlaylist}`);

    if (!self.currentTokenUid) {
        self.commandRouter.pushToastMessage('error', MY_LOG_NAME, "No NFC token detected");
        return false;
    }

    if (!effectivePlaylist) {
        self.commandRouter.pushToastMessage('error', MY_LOG_NAME, "Start the playlist which shall be assigned");
        return false;
    }

    self.logger.info('I shall assign token UID', self.currentTokenUid, 'to', effectivePlaylist);

    try {
        if (self.currentTokenUid && effectivePlaylist
            && self.tokenManager.assignToken(self.currentTokenUid, effectivePlaylist)) {
            self.commandRouter.pushToastMessage('success', MY_LOG_NAME, `Token ${self.currentTokenUid} assigned to ${effectivePlaylist}`);
            return true;
        }
    } catch (err) {
        self.logger.error('Error in assignPlaylist:', error);
        self.commandRouter.pushToastMessage('error', MY_LOG_NAME, err.message);
        self.logger.info(`${MY_LOG_NAME}: could not assign token uid`, self.currentTokenUid, err);
    }
};

NFCController.prototype.unassignToken = function(data = null) {
    const self = this;
    const tokenUid = data || self.currentTokenUid;

    self.logger.info(MY_LOG_NAME, 'shall unassign token', tokenUid);

    if (!tokenUid) {
        self.commandRouter.pushToastMessage('error', MY_LOG_NAME, "No NFC token detected");
        return false;
    }

    const unassignedPlaylist = self.tokenManager.unassignToken(tokenUid);
    if (unassignedPlaylist) {
        self.commandRouter.pushToastMessage('success', MY_LOG_NAME, `Token ${tokenUid} unassigned (was ${unassignedPlaylist})`);
    }
};


// module.exports = nfc-controller;
// function nfc-controller(context) {
// 	var self = this;

// 	this.context = context;
// 	this.commandRouter = this.context.coreCommand;
// 	this.logger = this.context.logger;
// 	this.configManager = this.context.configManager;

// }



// nfc-controller.prototype.onVolumioStart = function()
// {
// 	var self = this;
// 	var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
// 	this.config = new (require('v-conf'))();
// 	this.config.loadFile(configFile);

//     return libQ.resolve();
// }

// nfc-controller.prototype.onStart = function() {
//     var self = this;
// 	var defer=libQ.defer();


// 	// Once the Plugin has successfull started resolve the promise
// 	defer.resolve();

//     return defer.promise;
// };

// nfc-controller.prototype.onStop = function() {
//     var self = this;
//     var defer=libQ.defer();

//     // Once the Plugin has successfull stopped resolve the promise
//     defer.resolve();

//     return libQ.resolve();
// };

// nfc-controller.prototype.onRestart = function() {
//     var self = this;
//     // Optional, use if you need it
// };


// // Configuration Methods -----------------------------------------------------------------------------

// nfc-controller.prototype.getUIConfig = function() {
//     var defer = libQ.defer();
//     var self = this;

//     var lang_code = this.commandRouter.sharedVars.get('language_code');

//     self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
//         __dirname+'/i18n/strings_en.json',
//         __dirname + '/UIConfig.json')
//         .then(function(uiconf)
//         {


//             defer.resolve(uiconf);
//         })
//         .fail(function()
//         {
//             defer.reject(new Error());
//         });

//     return defer.promise;
// };

// nfc-controller.prototype.getConfigurationFiles = function() {
// 	return ['config.json'];
// }

// nfc-controller.prototype.setUIConfig = function(data) {
// 	var self = this;
// 	//Perform your installation tasks here
// };

// nfc-controller.prototype.getConf = function(varName) {
// 	var self = this;
// 	//Perform your installation tasks here
// };

// nfc-controller.prototype.setConf = function(varName, varValue) {
// 	var self = this;
// 	//Perform your installation tasks here
// };



// // Playback Controls ---------------------------------------------------------------------------------------
// // If your plugin is not a music_sevice don't use this part and delete it


// nfc-controller.prototype.addToBrowseSources = function () {

// 	// Use this function to add your music service plugin to music sources
//     //var data = {name: 'Spotify', uri: 'spotify',plugin_type:'music_service',plugin_name:'spop'};
//     this.commandRouter.volumioAddToBrowseSources(data);
// };

// nfc-controller.prototype.handleBrowseUri = function (curUri) {
//     var self = this;

//     //self.commandRouter.logger.info(curUri);
//     var response;


//     return response;
// };



// // Define a method to clear, add, and play an array of tracks
// nfc-controller.prototype.clearAddPlayTrack = function(track) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::clearAddPlayTrack');

// 	self.commandRouter.logger.info(JSON.stringify(track));

// 	return self.sendSpopCommand('uplay', [track.uri]);
// };

// nfc-controller.prototype.seek = function (timepos) {
//     this.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::seek to ' + timepos);

//     return this.sendSpopCommand('seek '+timepos, []);
// };

// // Stop
// nfc-controller.prototype.stop = function() {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::stop');


// };

// // Spop pause
// nfc-controller.prototype.pause = function() {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::pause');


// };

// // Get state
// nfc-controller.prototype.getState = function() {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::getState');


// };

// //Parse state
// nfc-controller.prototype.parseState = function(sState) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::parseState');

// 	//Use this method to parse the state and eventually send it with the following function
// };

// // Announce updated State
// nfc-controller.prototype.pushState = function(state) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'nfc-controller::pushState');

// 	return self.commandRouter.servicePushState(state, self.servicename);
// };


// nfc-controller.prototype.explodeUri = function(uri) {
// 	var self = this;
// 	var defer=libQ.defer();

// 	// Mandatory: retrieve all info for a given URI

// 	return defer.promise;
// };

// nfc-controller.prototype.getAlbumArt = function (data, path) {

// 	var artist, album;

// 	if (data != undefined && data.path != undefined) {
// 		path = data.path;
// 	}

// 	var web;

// 	if (data != undefined && data.artist != undefined) {
// 		artist = data.artist;
// 		if (data.album != undefined)
// 			album = data.album;
// 		else album = data.artist;

// 		web = '?web=' + nodetools.urlEncode(artist) + '/' + nodetools.urlEncode(album) + '/large'
// 	}

// 	var url = '/albumart';

// 	if (web != undefined)
// 		url = url + web;

// 	if (web != undefined && path != undefined)
// 		url = url + '&';
// 	else if (path != undefined)
// 		url = url + '?';

// 	if (path != undefined)
// 		url = url + 'path=' + nodetools.urlEncode(path);

// 	return url;
// };





// nfc-controller.prototype.search = function (query) {
// 	var self=this;
// 	var defer=libQ.defer();

// 	// Mandatory, search. You can divide the search in sections using following functions

// 	return defer.promise;
// };

// nfc-controller.prototype._searchArtists = function (results) {

// };

// nfc-controller.prototype._searchAlbums = function (results) {

// };

// nfc-controller.prototype._searchPlaylists = function (results) {


// };

// nfc-controller.prototype._searchTracks = function (results) {

// };

// nfc-controller.prototype.goto=function(data){
//     var self=this
//     var defer=libQ.defer()

// // Handle go to artist and go to album function

//      return defer.promise;
// };

