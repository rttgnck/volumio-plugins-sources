const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const VolumioCore = require('volumio-core-api');

class NowPlayingPlugin {
    constructor(context) {
        this.context = context;
        this.commandRouter = context.coreCommand;
        this.logger = context.logger;
        this.clients = [];
        this.initWebSocket();
    }

    initWebSocket() {
        const server = new WebSocket.Server({ port: 3001 });

        server.on('connection', (socket) => {
            this.logger.info('New encoder connected');
            this.clients.push(socket);

            socket.on('message', (data) => {
                this.logger.info('Message received: ' + data);
                this.handleCommand(JSON.parse(data));
            });

            socket.on('close', () => {
                this.clients = this.clients.filter((client) => client !== socket);
            });
        });
    }

    handleCommand(command) {
        switch (command.action) {
            case 'play':
                this.commandRouter.volumioPlay();
                break;
            case 'pause':
                this.commandRouter.volumioPause();
                break;
            case 'next':
                this.commandRouter.volumioNext();
                break;
            case 'previous':
                this.commandRouter.volumioPrevious();
                break;
            default:
                this.logger.error('Unknown command');
        }
    }

    broadcastNowPlaying(metadata) {
        this.clients.forEach((client) => {
            client.send(JSON.stringify(metadata));
        });
    }

    onPlayerStateChange(state) {
        const metadata = {
            artist: state.artist,
            album: state.album,
            title: state.title,
            duration: state.duration,
            image: state.albumart,
        };

        this.broadcastNowPlaying(metadata);
    }

    start() {
        // Register for player state changes
        this.commandRouter.on('volumioPlayerStateChanged', this.onPlayerStateChange.bind(this));
        this.logger.info('NowPlayingPlugin has started.');
    }

    stop() {
        this.logger.info('NowPlayingPlugin has stopped.');
    }
}

module.exports = NowPlayingPlugin;

// 'use strict';

// var libQ = require('kew');
// var fs=require('fs-extra');
// var config = new (require('v-conf'))();
// var exec = require('child_process').exec;
// var execSync = require('child_process').execSync;


// module.exports = remotecontrol;
// function remotecontrol(context) {
// 	var self = this;

// 	this.context = context;
// 	this.commandRouter = this.context.coreCommand;
// 	this.logger = this.context.logger;
// 	this.configManager = this.context.configManager;

// }



// remotecontrol.prototype.onVolumioStart = function()
// {
// 	var self = this;
// 	var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
// 	this.config = new (require('v-conf'))();
// 	this.config.loadFile(configFile);

//     return libQ.resolve();
// }

// remotecontrol.prototype.onStart = function() {
//     var self = this;
// 	var defer=libQ.defer();


// 	// Once the Plugin has successfull started resolve the promise
// 	defer.resolve();

//     return defer.promise;
// };

// remotecontrol.prototype.onStop = function() {
//     var self = this;
//     var defer=libQ.defer();

//     // Once the Plugin has successfull stopped resolve the promise
//     defer.resolve();

//     return libQ.resolve();
// };

// remotecontrol.prototype.onRestart = function() {
//     var self = this;
//     // Optional, use if you need it
// };


// // Configuration Methods -----------------------------------------------------------------------------

// remotecontrol.prototype.getUIConfig = function() {
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

// remotecontrol.prototype.getConfigurationFiles = function() {
// 	return ['config.json'];
// }

// remotecontrol.prototype.setUIConfig = function(data) {
// 	var self = this;
// 	//Perform your installation tasks here
// };

// remotecontrol.prototype.getConf = function(varName) {
// 	var self = this;
// 	//Perform your installation tasks here
// };

// remotecontrol.prototype.setConf = function(varName, varValue) {
// 	var self = this;
// 	//Perform your installation tasks here
// };



// // Playback Controls ---------------------------------------------------------------------------------------
// // If your plugin is not a music_sevice don't use this part and delete it


// remotecontrol.prototype.addToBrowseSources = function () {

// 	// Use this function to add your music service plugin to music sources
//     //var data = {name: 'Spotify', uri: 'spotify',plugin_type:'music_service',plugin_name:'spop'};
//     this.commandRouter.volumioAddToBrowseSources(data);
// };

// remotecontrol.prototype.handleBrowseUri = function (curUri) {
//     var self = this;

//     //self.commandRouter.logger.info(curUri);
//     var response;


//     return response;
// };



// // Define a method to clear, add, and play an array of tracks
// remotecontrol.prototype.clearAddPlayTrack = function(track) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::clearAddPlayTrack');

// 	self.commandRouter.logger.info(JSON.stringify(track));

// 	return self.sendSpopCommand('uplay', [track.uri]);
// };

// remotecontrol.prototype.seek = function (timepos) {
//     this.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::seek to ' + timepos);

//     return this.sendSpopCommand('seek '+timepos, []);
// };

// // Stop
// remotecontrol.prototype.stop = function() {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::stop');


// };

// // Spop pause
// remotecontrol.prototype.pause = function() {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::pause');


// };

// // Get state
// remotecontrol.prototype.getState = function() {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::getState');


// };

// //Parse state
// remotecontrol.prototype.parseState = function(sState) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::parseState');

// 	//Use this method to parse the state and eventually send it with the following function
// };

// // Announce updated State
// remotecontrol.prototype.pushState = function(state) {
// 	var self = this;
// 	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'remotecontrol::pushState');

// 	return self.commandRouter.servicePushState(state, self.servicename);
// };


// remotecontrol.prototype.explodeUri = function(uri) {
// 	var self = this;
// 	var defer=libQ.defer();

// 	// Mandatory: retrieve all info for a given URI

// 	return defer.promise;
// };

// remotecontrol.prototype.getAlbumArt = function (data, path) {

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





// remotecontrol.prototype.search = function (query) {
// 	var self=this;
// 	var defer=libQ.defer();

// 	// Mandatory, search. You can divide the search in sections using following functions

// 	return defer.promise;
// };

// remotecontrol.prototype._searchArtists = function (results) {

// };

// remotecontrol.prototype._searchAlbums = function (results) {

// };

// remotecontrol.prototype._searchPlaylists = function (results) {


// };

// remotecontrol.prototype._searchTracks = function (results) {

// };

// remotecontrol.prototype.goto=function(data){
//     var self=this
//     var defer=libQ.defer()

// // Handle go to artist and go to album function

//      return defer.promise;
// };
