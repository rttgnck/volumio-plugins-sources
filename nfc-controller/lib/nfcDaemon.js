'use strict';

const i2c = require('i2c-bus');
const PN532 = require('./pn532');
const serializeUid = require('./serializeUid');

const _I2C_ADDRESS = 0x24;

// class PN532_I2C extends PN532 {
//     constructor(i2c_bus, i2cAddress = _I2C_ADDRESS, debug = false) {
//         super(debug);
        
//         if (typeof i2c_bus === 'undefined') {
//             i2c_bus = 1;
//         }
        
//         this._address = i2cAddress;
//         try {
//             this._wire = i2c.openSync(i2c_bus);
//         } catch (err) {
//             throw new Error(`i2c_bus i2c-${i2c_bus} not exist!`);
//         }
        
//         this.debug = debug;
//     }

//     _wakeup() {
//         // Send any special commands/data to wake up PN532
//         this.low_power = false;
//         this.SAM_configuration(); // Put the PN532 back in normal mode
//     }

//     _wait_ready(timeout = 1) {
//         // Poll PN532 if status byte is ready, up to `timeout` seconds
//         const status = Buffer.alloc(1);
//         const timestamp = new Date().getTime();
        
//         while ((new Date().getTime() - timestamp) < timeout * 2000) {
//             try {
//                 this._wire.i2cReadSync(this._address, 1, status);
//                 if (status[0] === 0x01) {
//                     return true; // No longer busy
//                 }
//             } catch (err) {
//                 continue;
//             }
//             this.delay_ms(10); // Wait before asking again
//         }
//         return false;
//     }

//     _read_data(count) {
//         // Read a specified count of bytes from the PN532
//         const frame = Buffer.alloc(count + 1);
        
//         // Read status byte
//         this._wire.i2cReadSync(this._address, 1, frame);
//         if (frame[0] !== 0x01) {
//             throw new Error('busy!');
//         }

//         this._wire.i2cReadSync(this._address, count + 1, frame);
        
//         return frame.slice(1); // Don't return the status byte
//     }

//     _write_data(framebytes) {
//         // Write data to the PN532
//         this._wire.i2cWriteSync(this._address, framebytes.length, framebytes);
//     }

//     close() {
//         if (this._wire) {
//             this._wire.closeSync();
//             this._wire = null;
//         }
//     }
// }

class PN532_I2C extends PN532 {
    constructor(i2c_bus, i2cAddress = _I2C_ADDRESS, debug = false) {
        super(debug);
        
        if (typeof i2c_bus === 'undefined') {
            i2c_bus = 1;
        }
        
        this._address = i2cAddress;
        this._retries = 3;
        this._retryDelay = 50;
        this._i2cBusNumber = i2c_bus;
        
        try {
            this._wire = i2c.openSync(this._i2cBusNumber);
            this.debug = debug;
            this._lastReadTime = 0;
            this._minReadInterval = 20;
        } catch (err) {
            const errorMsg = `Failed to open I2C bus ${this._i2cBusNumber}. ` +
                           `Please ensure I2C is enabled in raspi-config and the user has permissions.\n` +
                           `Original error: ${err.message}`;
            throw new Error(errorMsg);
        }
    }

    _wakeup() {
        // Send wake up command to PN532
        try {
            // Send an empty write as a wake-up
            const wakeupBuffer = Buffer.from([0x00]);
            this._wire.i2cWriteSync(this._address, wakeupBuffer.length, wakeupBuffer);
            
            // Wait a moment for the device to wake up
            this.delay_ms(100);
            
            // Send SAM configuration command to ensure device is in normal mode
            this.SAM_configuration();
            
            // Clear any pending reads
            try {
                const clearBuffer = Buffer.alloc(1);
                this._wire.i2cReadSync(this._address, 1, clearBuffer);
            } catch (err) {
                // Ignore read errors during wakeup
            }
            
            this.low_power = false;
        } catch (err) {
            throw new Error(`Failed to wake up PN532: ${err.message}`);
        }
    }

    _wait_ready(timeout = 1) {
        const status = Buffer.alloc(1);
        const timestamp = new Date().getTime();
        let retries = 0;
        
        while ((new Date().getTime() - timestamp) < timeout * 1000 && retries < this._retries) {
            try {
                this._wire.i2cReadSync(this._address, 1, status);
                if (status[0] === 0x01) {
                    return true;
                }
            } catch (err) {
                retries++;
                if (retries < this._retries) {
                    this.delay_ms(this._retryDelay);
                }
                continue;
            }
            this.delay_ms(10);
        }
        return false;
    }

    _read_data(count) {
        const now = Date.now();
        const timeSinceLastRead = now - this._lastReadTime;
        
        if (timeSinceLastRead < this._minReadInterval) {
            this.delay_ms(this._minReadInterval - timeSinceLastRead);
        }
        
        const frame = Buffer.alloc(count + 1);
        let success = false;
        let retries = 0;
        
        while (!success && retries < this._retries) {
            try {
                this._wire.i2cReadSync(this._address, 1, frame);
                if (frame[0] !== 0x01) {
                    retries++;
                    if (retries < this._retries) {
                        this.delay_ms(this._retryDelay);
                    }
                    continue;
                }
                
                this._wire.i2cReadSync(this._address, count + 1, frame);
                success = true;
            } catch (err) {
                retries++;
                if (retries < this._retries) {
                    this.delay_ms(this._retryDelay);
                } else {
                    throw err;
                }
            }
        }
        
        this._lastReadTime = Date.now();
        return frame.slice(1);
    }

    _write_data(framebytes) {
        try {
            let retries = 0;
            let success = false;
            
            while (!success && retries < this._retries) {
                try {
                    this._wire.i2cWriteSync(this._address, framebytes.length, framebytes);
                    success = true;
                } catch (err) {
                    retries++;
                    if (retries < this._retries) {
                        this.delay_ms(this._retryDelay);
                    } else {
                        throw err;
                    }
                }
            }
        } catch (err) {
            throw new Error(`Failed to write to PN532: ${err.message}`);
        }
    }

    close() {
        if (this._wire) {
            this._wire.closeSync();
            this._wire = null;
        }
    }
}

// class NFCDaemon {
//     constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
//         this.interval = interval;
//         this.logger = logger;
        
//         this.intervalHandle = null;
//         this.currentUID = null;
//         this.debounceCounter = 0;
//         this.isFirstRead = true;
        
//         this.onCardDetected = onCardDetected;
//         this.onCardRemoved = onCardRemoved;
//         this.debounceThreshold = debounceThreshold;
        
//         this.reader = new PN532_I2C(i2cBusNumber, _I2C_ADDRESS, false);
//         this.watcher = this.watcher.bind(this);
//     }

//     async start() {
//         try {
//             this.logger.info('NFC Daemon: Initializing...');
            
//             // Wake up and initialize
//             this.reader._wakeup();
            
//             // Get firmware version
//             const version = this.reader.firmware_version();
//             if (!version) {
//                 this.logger.error("Failed to get PN532 firmware version");
//                 return false;
//             }

//             // Format version info properly
//             const versionInfo = {
//                 ic: version[0],
//                 ver: version[1],
//                 rev: version[2],
//                 support: version[3]
//             };
//             this.logger.info('Found PN532 with firmware version:', 
//                 `IC: 0x${versionInfo.ic.toString(16)}, ` +
//                 `Ver: 0x${versionInfo.ver.toString(16)}, ` +
//                 `Rev: 0x${versionInfo.rev.toString(16)}, ` +
//                 `Support: 0x${versionInfo.support.toString(16)}`
//             );
            
//             this.reader.SAM_configuration();
            
//             this.logger.info('NFC Daemon:', `going to poll the reader every ${this.interval}ms`);
//             this.intervalHandle = setInterval(this.watcher, this.interval);
//             return true;
//         } catch (err) {
//             this.logger.error('Error starting NFC Daemon:', err);
//             return false;
//         }
//     }

//     stop() {
//         if (this.intervalHandle) {
//             clearInterval(this.intervalHandle);
//             this.intervalHandle = null;
//         }
//         if (this.reader) {
//             this.reader.close();
//         }
//     }

//     async watcher() {
//         try {
//             // Try to read card UID
//             const uid = this.reader.read_passive_target();
            
//             if (this.isFirstRead) {
//                 this.isFirstRead = false;
//                 return;
//             }
            
//             if (!uid) {
//                 if (this.currentUID) {
//                     if (this.debounceCounter >= this.debounceThreshold) {
//                         this.logger.info('Card removed:', this.currentUID);
//                         this.onCardRemoved(this.currentUID);
//                         this.currentUID = null;
//                         this.debounceCounter = 0;
//                     } else {
//                         this.debounceCounter++;
//                     }
//                 }
//             } else {
//                 this.debounceCounter = 0;
//                 const uidString = serializeUid(Array.from(uid));
//                 if (!this.currentUID || this.currentUID !== uidString) {
//                     this.logger.info('New card detected:', uidString);
//                     this.currentUID = uidString;
//                     this.onCardDetected(this.currentUID);
//                 }
//             }
//         } catch (err) {
//             this.logger.error('Error in watcher:', err.message);
//             // Try to reinitialize on error
//             try {
//                 this.reader._wakeup();
//             } catch (e) {
//                 this.logger.error('Error reinitializing:', e);
//             }
//         }
//     }
// }

class NFCDaemon {
    constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 1000, debounceThreshold = 5) {
        this.interval = interval;
        this.logger = logger;
        
        this.intervalHandle = null;
        this.currentUID = null;
        this.debounceCounter = 0;
        this.isFirstRead = true;
        this.lastErrorTime = 0;
        this.errorCount = 0;
        
        this.onCardDetected = onCardDetected;
        this.onCardRemoved = onCardRemoved;
        this.debounceThreshold = debounceThreshold;
        
        this.reader = new PN532_I2C(i2cBusNumber, _I2C_ADDRESS, false);
        this.watcher = this.watcher.bind(this);
        
        // Add error backoff handling
        this.baseInterval = interval;
        this.maxInterval = interval * 4;
        this.currentInterval = interval;
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
            this.scheduleNextPoll();
            return true;
        } catch (err) {
            this.logger.error('Error starting NFC Daemon:', err);
            return false;
        }
    }

    stop() {
        if (this.intervalHandle) {
            clearTimeout(this.intervalHandle);
            this.intervalHandle = null;
        }
        if (this.reader) {
            this.reader.close();
        }
    }

    scheduleNextPoll() {
        if (this.intervalHandle) {
            clearTimeout(this.intervalHandle);
        }
        this.intervalHandle = setTimeout(this.watcher, this.currentInterval);
    }

    async watcher() {
        try {
            // Try to read card UID
            const uid = this.reader.read_passive_target();
            
            if (this.isFirstRead) {
                this.isFirstRead = false;
                this.scheduleNextPoll();
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
                // Gradually decrease polling interval when no card is present
                this.currentInterval = Math.min(this.currentInterval + 100, this.maxInterval);
            } else {
                this.debounceCounter = 0;
                const uidString = serializeUid(Array.from(uid));
                if (!this.currentUID || this.currentUID !== uidString) {
                    this.logger.info('New card detected:', uidString);
                    this.currentUID = uidString;
                    this.onCardDetected(this.currentUID);
                }
                // Reset to base interval when card is present
                this.currentInterval = this.baseInterval;
            }
            
            // Reset error count on successful read
            this.errorCount = 0;
            
        } catch (err) {
            this.errorCount++;
            const now = Date.now();
            
            // Implement exponential backoff on errors
            if (this.errorCount > 3) {
                this.currentInterval = Math.min(this.currentInterval * 1.5, this.maxInterval);
                this.logger.error('Multiple errors detected, increasing polling interval to:', this.currentInterval);
            }
            
            // Only log errors once per minute to prevent log spam
            if (now - this.lastErrorTime > 60000) {
                this.logger.error('Error in watcher:', err.message);
                this.lastErrorTime = now;
            }
            
            // Try to reinitialize on error
            try {
                this.reader._wakeup();
            } catch (e) {
                // Only log reinitialization errors once per minute
                if (now - this.lastErrorTime > 60000) {
                    this.logger.error('Error reinitializing:', e);
                }
            }
        }
        
        this.scheduleNextPoll();
    }
}

module.exports = NFCDaemon;