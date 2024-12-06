const CONFIG_PATH = '/data/configuration/user_interface/nfc_controller/';
const TokenManager = require('./tokenManager');

const getTokenManager = function (logger = console) {
    return new TokenManager(CONFIG_PATH + 'data/tokenmanager.db', logger);
}

module.exports = getTokenManager;