'use strict';

const i2c = require('i2c-bus');
const serializeUid = require('./serializeUid');

// MFRC522 Register addresses
const REGISTERS = {
    COMMAND: 0x01,
    COM_IRQ: 0x04,
    ERROR: 0x06,
    STATUS1: 0x07,
    STATUS2: 0x08,
    FIFO_DATA: 0x09,
    FIFO_LEVEL: 0x0A,
    CONTROL: 0x0C,
    BIT_FRAMING: 0x0D,
    MODE: 0x11,
    TX_CONTROL: 0x14,
    TX_AUTO: 0x15,
    VERSION: 0x37,
    ANTICOLL: 0x93
};

// MFRC522 Commands
const COMMANDS = {
    IDLE: 0x00,
    AUTH: 0x0E,
    RECEIVE: 0x08,
    TRANSMIT: 0x04,
    TRANSCEIVE: 0x0C,
    RESET_PHASE: 0x0F,
    CALC_CRC: 0x03
};

// MFRC522 Status
const STATUS = {
    OK: 0,
    ERROR: 2,
    NOTAGERR: 1,
    TIMEOUT: 3
};

class MFRC522Daemon {
    constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        const self = this;
        
        self.interval = interval;
        self.logger = logger;
        self.i2cBusNumber = i2cBusNumber;
        self.i2cAddress = 0x24; // MFRC522 I2C address
        
        self.logger.info(`MFRC522Daemon: Using I2C bus ${i2cBusNumber} with address 0x${self.i2cAddress.toString(16)}`);
        
        self.intervalHandle = null;
        self.currentUID = null;
        self.debounceCounter = 0;
        
        self.onCardDetected = onCardDetected;
        self.onCardRemoved = onCardRemoved;
        self.debounceThreshold = debounceThreshold;
        
        self.i2cBus = null;
        this.watcher = this.watcher.bind(this);
    }

    async init() {
        try {
            this.logger.info(`Opening I2C bus ${this.i2cBusNumber}`);
            this.i2cBus = i2c.openSync(this.i2cBusNumber);

            // Reset the MFRC522
            await this.reset();
            
            // Wait for reset to complete
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Check version
            const version = await this.readRegister(REGISTERS.VERSION);
            this.logger.info('MFRC522 version:', version ? version.toString(16) : 'unknown');
            
            if (!version) {
                this.logger.error('Failed to initialize MFRC522. No response from device');
                return false;
            }

            // Initialize the reader
            await this.writeRegister(REGISTERS.TX_MODE, 0x00);
            await this.writeRegister(REGISTERS.RX_MODE, 0x00);
            // Reset ModWidthReg
            await this.writeRegister(0x24, 0x26);

            this.logger.info('MFRC522 initialized successfully');
            return true;

        } catch (err) {
            this.logger.error('Error initializing MFRC522:', err);
            if (err.code === 'ENOENT') {
                this.logger.error(`Could not open I2C bus ${this.i2cBusNumber}. Make sure I2C is enabled and the bus exists.`);
                this.logger.error('Try: sudo raspi-config -> Interface Options -> I2C -> Enable');
                this.logger.error('Also check: ls -l /dev/i2c*');
            }
            return false;
        }
    }

    async reset() {
        await this.writeRegister(REGISTERS.COMMAND, COMMANDS.RESET_PHASE);
    }

    async checkCardPresence() {
        try {
            // Clear all interrupt flags
            await this.writeRegister(REGISTERS.COM_IRQ, 0x7F);
            
            // Send REQA command
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x07);  // 7 bits
            
            const result = await this.transceive([0x26], 7);  // REQA command
            return result !== null;
        } catch (err) {
            this.logger.error('Error checking card presence:', err);
            return false;
        }
    }

    async readCardUID() {
        try {
            // Send anti-collision command
            const result = await this.transceive([REGISTERS.ANTICOLL, 0x20], 0);
            if (!result || result.length !== 5) {
                return null;
            }

            const uid = result.slice(0, 4);
            return serializeUid(uid);
        } catch (err) {
            this.logger.error('Error reading card UID:', err);
            return null;
        }
    }

    async transceive(data, validBits = 0) {
        try {
            // Prepare for transmission
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.IDLE);
            await this.writeRegister(REGISTERS.COM_IRQ, 0x7F);
            await this.writeRegister(REGISTERS.FIFO_LEVEL, 0x80);  // Clear FIFO

            // Write data to FIFO
            for (const byte of data) {
                await this.writeRegister(REGISTERS.FIFO_DATA, byte);
            }

            // Set bit framing
            if (validBits !== 0) {
                await this.writeRegister(REGISTERS.BIT_FRAMING, validBits);
            }

            // Start transmission
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.TRANSCEIVE);
            
            // Wait for completion
            let status;
            const timeout = Date.now() + 100;  // 100ms timeout
            do {
                status = await this.readRegister(REGISTERS.COM_IRQ);
                if (Date.now() > timeout) {
                    this.logger.error('Transceive timeout');
                    return null;
                }
            } while ((status & 0x30) === 0);

            // Read response
            const length = await this.readRegister(REGISTERS.FIFO_LEVEL);
            const result = [];
            for (let i = 0; i < length; i++) {
                result.push(await this.readRegister(REGISTERS.FIFO_DATA));
            }

            return result;
        } catch (err) {
            this.logger.error('Error in transceive:', err);
            return null;
        }
    }

    writeRegister(register, value) {
        return new Promise((resolve, reject) => {
            if (!this.i2cBus) {
                reject(new Error('I2C bus not initialized'));
                return;
            }
            
            this.logger.debug(`Writing to register 0x${register.toString(16)}: 0x${value.toString(16)}`);
            this.i2cBus.writeByte(this.i2cAddress, register, value, (err) => {
                if (err) {
                    this.logger.error(`Error writing to register ${register.toString(16)}:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    readRegister(register) {
        return new Promise((resolve, reject) => {
            if (!this.i2cBus) {
                reject(new Error('I2C bus not initialized'));
                return;
            }

            this.i2cBus.readByte(this.i2cAddress, register, (err, value) => {
                if (err) {
                    this.logger.error(`Error reading from register ${register.toString(16)}:`, err);
                    reject(err);
                } else {
                    this.logger.debug(`Read from register 0x${register.toString(16)}: 0x${value.toString(16)}`);
                    resolve(value);
                }
            });
        });
    }

    async start() {
        try {
            this.logger.info('NFC Daemon: Initializing...');
            const initialized = await this.init();
            if (!initialized) {
                this.logger.error('Failed to initialize NFC reader. Not starting watcher.');
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
        if (this.i2cBus) {
            try {
                this.i2cBus.closeSync();
            } catch (err) {
                this.logger.error('Error closing I2C bus:', err);
            }
            this.i2cBus = null;
        }
    }

    // Make watcher async and add error handling
    async watcher() {
        try {
            if (!this.i2cBus) {
                this.logger.error('I2C bus not initialized');
                return;
            }

            // Read card presence by checking if a card is in the field
            const cardPresent = await this.checkCardPresence();
            
            if (!cardPresent) {
                if (this.currentUID) {
                    if (this.debounceCounter >= this.debounceThreshold) {
                        this.onCardRemoved(this.currentUID);
                        this.currentUID = null;
                    } else {
                        this.debounceCounter++;
                    }
                }
            } else {
                const uid = await this.readCardUID();
                if (uid) {
                    this.debounceCounter = 0;
                    if (!this.currentUID || this.currentUID !== uid) {
                        this.currentUID = uid;
                        this.onCardDetected(this.currentUID);
                    }
                }
            }
        } catch (err) {
            this.logger.error('Error reading MFRC522:', err);
            // Try to reinitialize if we lost connection
            if (err.code === 'ENOENT' || err.code === 'EIO') {
                this.stop();
                await this.init();
            }
        }
    }
}

module.exports = MFRC522Daemon;
