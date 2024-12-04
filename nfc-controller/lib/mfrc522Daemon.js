'use strict';

const i2c = require('i2c-bus');
const serializeUid = require('./serializeUid');

// PN532 Constants
const PN532_PREAMBLE = 0x00;
const PN532_STARTCODE1 = 0x00;
const PN532_STARTCODE2 = 0xFF;
const PN532_POSTAMBLE = 0x00;

const PN532_HOSTTOPN532 = 0xD4;
const PN532_PN532TOHOST = 0xD5;

// PN532 Commands
const PN532_COMMAND = {
    GETFIRMWAREVERSION: 0x02,
    SAMCONFIGURATION: 0x14,
    INLISTPASSIVETARGET: 0x4A,
};

class PN532 {
    constructor(busNumber = 1, address = 0x24, logger = console) {
        this.address = address;
        this.busNumber = busNumber;
        this.logger = logger;
        this.wire = null;
        this.debug = false;
    }

    async begin() {
        try {
            this.wire = i2c.openSync(this.busNumber);
            this.logger.info(`Opened I2C bus ${this.busNumber}`);
            
            // Wake up the PN532
            await this._wakeup();
            return true;
        } catch (err) {
            this.logger.error('Failed to initialize PN532:', err);
            return false;
        }
    }

    async getFirmwareVersion() {
        try {
            const response = await this.writeCommand([PN532_COMMAND.GETFIRMWAREVERSION]);
            if (!response || response.length < 4) {
                return null;
            }
            
            const version = {
                ic: response[0],
                ver: response[1],
                rev: response[2],
                support: response[3]
            };
            
            this.logger.info('PN532 Firmware version:', version);
            return version;
        } catch (err) {
            this.logger.error('Error getting firmware version:', err);
            return null;
        }
    }

    async SAMConfig() {
        try {
            // Configure SAM to normal mode, timeout of 50ms, use IRQ pin
            const response = await this.writeCommand([
                PN532_COMMAND.SAMCONFIGURATION,
                0x01, // Normal mode
                0x14, // Timeout 50ms * 20 = 1 second
                0x01  // Use IRQ pin
            ]);
            
            return response !== null;
        } catch (err) {
            this.logger.error('Error configuring SAM:', err);
            return false;
        }
    }

    async readPassiveTargetID() {
        try {
            const response = await this.writeCommand([
                PN532_COMMAND.INLISTPASSIVETARGET,
                0x01,  // MaxTg = 1, only look for one target
                0x00   // BrTy = ISO14443A
            ]);

            if (!response || response.length < 7) {
                return null;
            }

            // Check if a card was found
            if (response[0] !== 0x01) {
                return null;
            }

            // Extract UID length and UID from response
            const uidLength = response[5];
            const uid = response.slice(6, 6 + uidLength);

            return { uid: Array.from(uid) };
        } catch (err) {
            this.logger.error('Error reading passive target:', err);
            return null;
        }
    }

    async writeCommand(command) {
        const frameData = [
            PN532_HOSTTOPN532,
            ...command
        ];
        
        // Calculate checksum
        let sum = frameData.reduce((a, b) => a + b, 0);
        let checksum = (-sum & 0xFF);
        
        // Build complete frame
        const frame = Buffer.from([
            PN532_PREAMBLE,
            PN532_STARTCODE1,
            PN532_STARTCODE2,
            frameData.length,
            ~frameData.length & 0xFF,
            ...frameData,
            checksum,
            PN532_POSTAMBLE
        ]);

        // Write the command
        this.wire.i2cWriteSync(this.address, frame.length, frame);
        
        // Wait for response
        if (!await this._waitReady(1)) {
            throw new Error('Timeout waiting for response');
        }
        
        // Read response
        return this._readData(frameData.length + 2);
    }

    async _waitReady(timeout = 1) {
        const startTime = Date.now();
        while ((Date.now() - startTime) < timeout * 1000) {
            try {
                const status = Buffer.alloc(1);
                this.wire.i2cReadSync(this.address, 1, status);
                if (status[0] === 0x01) {
                    return true;
                }
            } catch (err) {
                this.logger.debug('Wait ready error:', err);
            }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        return false;
    }

    _readData(count) {
        // Read initial status byte
        const status = Buffer.alloc(1);
        this.wire.i2cReadSync(this.address, 1, status);
        if (status[0] !== 0x01) {
            throw new Error('PN532 not ready');
        }

        // Read response data
        const frame = Buffer.alloc(count);
        this.wire.i2cReadSync(this.address, frame.length, frame);
        
        return frame;
    }

    async _wakeup() {
        // Send wake up command
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.SAMConfig();
    }

    close() {
        if (this.wire) {
            try {
                this.wire.closeSync();
                this.wire = null;
            } catch (err) {
                this.logger.error('Error closing I2C connection:', err);
            }
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
        
        this.reader = new PN532(i2cBusNumber, 0x24, logger);
        this.watcher = this.watcher.bind(this);
    }

    async start() {
        try {
            this.logger.info('NFC Daemon: Initializing...');
            const initialized = await this.reader.begin();
            if (!initialized) {
                this.logger.error('Failed to initialize NFC reader. Not starting watcher.');
                return false;
            }
            
            const version = await this.reader.getFirmwareVersion();
            if (!version) {
                this.logger.error('Failed to get PN532 firmware version');
                return false;
            }
            
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
            const result = await this.reader.readPassiveTargetID();
            const uid = result ? serializeUid(result.uid) : null;
            
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
                if (!this.currentUID || this.currentUID !== uid) {
                    this.logger.info('New card detected:', uid);
                    this.currentUID = uid;
                    this.onCardDetected(this.currentUID);
                }
            }
        } catch (err) {
            this.logger.error('Error in watcher:', err.message);
            // Try to reinitialize on error
            await this.reader.begin();
        }
    }
}

module.exports = NFCDaemon;


////////OLD CODE THAT WORKS, BUT DOESNT NOT RETURN THE UID////////
// 'use strict';

// const i2c = require('i2c-bus');
// const serializeUid = require('./serializeUid');

// class SimpleMFRC522 {
//     constructor(busNumber = 1, address = 0x24, logger = console) {
//         this.address = address;
//         this.busNumber = busNumber;
//         this.logger = logger;
//         this.bus = null;
//     }

//     async init() {
//         try {
//             this.bus = await i2c.openPromisified(this.busNumber);
//             this.logger.info(`Opened I2C bus ${this.busNumber}`);
            
//             // Clear any pending data by doing an initial read
//             await this.readCard();
//             // Small delay to ensure the reader is stable
//             await new Promise(resolve => setTimeout(resolve, 100));
            
//             return true;
//         } catch (err) {
//             this.logger.error('Failed to open I2C bus:', err);
//             return false;
//         }
//     }

//     async readCard() {
//         if (!this.bus) {
//             throw new Error('I2C bus not initialized');
//         }

//         try {
//             // Read card ID (4 bytes)
//             const buffer = Buffer.alloc(4);
//             await this.bus.i2cRead(this.address, buffer.length, buffer);
//             this.logger.info('Read buffer:', buffer);

//             // Check if all bytes are 0 or all bytes are 255 (common no-card states)
//             const isAllZero = buffer.every(byte => byte === 0);
//             const isAllFF = buffer.every(byte => byte === 0xFF);
//             this.logger.info('Buffer check - All Zero:', isAllZero, 'All FF:', isAllFF);
            
//             if (isAllZero || isAllFF) {
//                 this.logger.warn('No card detected (all bytes are zero or 255)');
//                 return null;
//             }

//             // return serializeUid(Array.from(buffer));
//             return null;
//         } catch (err) {
//             this.logger.error('Error reading card:', err.message);
//             return null;
//         }
//     }

//     async close() {
//         if (this.bus) {
//             try {
//                 await this.bus.close();
//                 this.bus = null;
//             } catch (err) {
//                 this.logger.error('Error closing I2C bus:', err);
//             }
//         }
//     }
// }

// class MFRC522Daemon {
//     constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
//         this.interval = interval;
//         this.logger = logger;
//         this.i2cBusNumber = i2cBusNumber;
        
//         this.intervalHandle = null;
//         this.currentUID = null;
//         this.debounceCounter = 0;
//         this.isFirstRead = true;
        
//         this.onCardDetected = onCardDetected;
//         this.onCardRemoved = onCardRemoved;
//         this.debounceThreshold = debounceThreshold;
        
//         this.reader = new SimpleMFRC522(i2cBusNumber, 0x24, logger);
//         this.watcher = this.watcher.bind(this);
//     }

//     async start() {
//         try {
//             this.logger.info('NFC Daemon: Initializing...');
//             const initialized = await this.reader.init();
//             if (!initialized) {
//                 this.logger.error('Failed to initialize NFC reader. Not starting watcher.');
//                 return false;
//             }
            
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
//             this.reader.close().catch(err => {
//                 this.logger.error('Error closing reader:', err);
//             });
//         }
//     }

//     async watcher() {
//         try {
//             const uid = await this.reader.readCard();
            
//             // Skip the first read after initialization
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
//                 if (!this.currentUID || this.currentUID !== uid) {
//                     this.logger.info('New card detected:', uid);
//                     this.currentUID = uid;
//                     this.onCardDetected(this.currentUID);
//                 }
//             }
//         } catch (err) {
//             this.logger.error('Error in watcher:', err.message);
//             if (err.code === 'ENODEV' || err.code === 'EIO') {
//                 this.logger.info('Attempting to reinitialize reader...');
//                 await this.reader.init();
//             }
//         }
//     }
// }

// module.exports = MFRC522Daemon;