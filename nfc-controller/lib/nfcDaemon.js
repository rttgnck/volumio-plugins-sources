'use strict';

const i2c = require('i2c-bus');
const PN532 = require('./pn532');
const serializeUid = require('./serializeUid');

const _I2C_ADDRESS = 0x24;

class PN532_I2C extends PN532 {
    constructor(i2c_bus, i2cAddress = _I2C_ADDRESS, debug = false) {
        super(debug);
        
        if (typeof i2c_bus === 'undefined') {
            i2c_bus = 1;
        }
        
        this._address = i2cAddress;
        try {
            this._wire = i2c.openSync(i2c_bus);
        } catch (err) {
            throw new Error(`i2c_bus i2c-${i2c_bus} not exist!`);
        }
        
        this.debug = debug;
    }

    _wakeup() {
        // Send any special commands/data to wake up PN532
        this.low_power = false;
        this.SAM_configuration(); // Put the PN532 back in normal mode
    }

    _wait_ready(timeout = 1) {
        // Poll PN532 if status byte is ready, up to `timeout` seconds
        const status = Buffer.alloc(1);
        const timestamp = new Date().getTime();
        
        while ((new Date().getTime() - timestamp) < timeout * 2000) {
            try {
                this._wire.i2cReadSync(this._address, 1, status);
                if (status[0] === 0x01) {
                    return true; // No longer busy
                }
            } catch (err) {
                continue;
            }
            this.delay_ms(10); // Wait before asking again
        }
        return false;
    }

    _read_data(count) {
        // Read a specified count of bytes from the PN532
        const frame = Buffer.alloc(count + 1);
        
        // Read status byte
        this._wire.i2cReadSync(this._address, 1, frame);
        if (frame[0] !== 0x01) {
            throw new Error('busy!');
        }

        this._wire.i2cReadSync(this._address, count + 1, frame);
        
        return frame.slice(1); // Don't return the status byte
    }

    _write_data(framebytes) {
        // Write data to the PN532
        this._wire.i2cWriteSync(this._address, framebytes.length, framebytes);
    }

    close() {
        if (this._wire) {
            this._wire.closeSync();
            this._wire = null;
        }
    }
}

class NFCDaemon {
    constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        this.interval = interval;
        this.logger = logger;
        
        this.intervalHandle = null;
        this.currentUID = null;
        this.debounceCounter = 0;
        this.isFirstRead = true;
        
        this.onCardDetected = onCardDetected;
        this.onCardRemoved = onCardRemoved;
        this.debounceThreshold = debounceThreshold;
        
        this.reader = new PN532_I2C(i2cBusNumber, _I2C_ADDRESS, false);
        this.watcher = this.watcher.bind(this);
    }

    async start() {
        try {
            this.logger.info('NFC Daemon: Initializing...');
            
            // Wake up and initialize
            this.reader._wakeup();
            
            // Get firmware version
            const version = this.reader.firmware_version();
            if (!version) {
                this.logger.error("Failed to get PN532 firmware version");
                return false;
            }

            // Format version info properly
            const versionInfo = {
                ic: version[0],
                ver: version[1],
                rev: version[2],
                support: version[3]
            };
            this.logger.info('Found PN532 with firmware version:', 
                `IC: 0x${versionInfo.ic.toString(16)}, ` +
                `Ver: 0x${versionInfo.ver.toString(16)}, ` +
                `Rev: 0x${versionInfo.rev.toString(16)}, ` +
                `Support: 0x${versionInfo.support.toString(16)}`
            );
            
            this.reader.SAM_configuration();
            
            this.logger.info('NFC Daemon:', `going to poll the reader every ${this.interval}ms`);
            this.intervalHandle = setInterval(this.watcher, this.interval);
            return true;
        } catch (err) {
            this.logger.error('Error starting NFC Daemon:', err);
            return false;
        }
    }

    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        if (this.reader) {
            this.reader.close();
        }
    }

    async watcher() {
        try {
            // Try to read card UID
            const uid = this.reader.read_passive_target();
            
            if (this.isFirstRead) {
                this.isFirstRead = false;
                return;
            }
            
            if (!uid) {
                if (this.currentUID) {
                    if (this.debounceCounter >= this.debounceThreshold) {
                        this.logger.info('Card removed:', this.currentUID);
                        this.onCardRemoved(this.currentUID);
                        this.currentUID = null;
                        this.debounceCounter = 0;
                    } else {
                        this.debounceCounter++;
                    }
                }
            } else {
                this.debounceCounter = 0;
                const uidString = serializeUid(Array.from(uid));
                if (!this.currentUID || this.currentUID !== uidString) {
                    this.logger.info('New card detected:', uidString);
                    this.currentUID = uidString;
                    this.onCardDetected(this.currentUID);
                }
            }
        } catch (err) {
            this.logger.error('Error in watcher:', err.message);
            // Try to reinitialize on error
            try {
                this.reader._wakeup();
            } catch (e) {
                this.logger.error('Error reinitializing:', e);
            }
        }
    }
}

module.exports = NFCDaemon;