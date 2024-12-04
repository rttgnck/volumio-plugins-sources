'use strict';

const i2c = require('i2c-bus');
const serializeUid = require('./serializeUid');

// MFRC522 Register addresses
const REGISTERS = {
    COMMAND: 0x01,
    COM_IRQ: 0x04,
    DIV_IRQ: 0x05,
    ERROR: 0x06,
    STATUS1: 0x07,
    STATUS2: 0x08,
    FIFO_DATA: 0x09,
    FIFO_LEVEL: 0x0A,
    CONTROL: 0x0C,
    BIT_FRAMING: 0x0D,
    MODE: 0x11,
    TX_CONTROL: 0x14,
    TX_ASK: 0x15,
    TX_MODE: 0x12,
    RX_MODE: 0x13,
    VERSION: 0x37,
    ANTICOLL: 0x93,
    TModeReg: 0x2A,
    TPrescalerReg: 0x2B,
    TReloadRegH: 0x2C,
    TReloadRegL: 0x2D
};

// MFRC522 Commands
const COMMANDS = {
    IDLE: 0x00,
    MEM: 0x01,
    GENERATE_RANDOM_ID: 0x02,
    CALC_CRC: 0x03,
    TRANSMIT: 0x04,
    NO_CMD_CHANGE: 0x07,
    RECEIVE: 0x08,
    TRANSCEIVE: 0x0C,
    MF_AUTHENT: 0x0E,
    SOFT_RESET: 0x0F
};

class MFRC522Daemon {
    constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        this.interval = interval;
        this.logger = logger;
        this.i2cBusNumber = i2cBusNumber;
        this.i2cAddress = 0x24;  // Default MFRC522 I2C address
        
        this.logger.info(`MFRC522Daemon: Using I2C bus ${i2cBusNumber} with address 0x${this.i2cAddress.toString(16)}`);
        
        this.intervalHandle = null;
        this.currentUID = null;
        this.debounceCounter = 0;
        
        this.onCardDetected = onCardDetected;
        this.onCardRemoved = onCardRemoved;
        this.debounceThreshold = debounceThreshold;
        
        this.i2cBus = null;
        this.watcher = this.watcher.bind(this);
    }

    async init() {
        try {
            this.logger.info(`Opening I2C bus ${this.i2cBusNumber}`);
            this.i2cBus = i2c.openSync(this.i2cBusNumber);
            
            // Wait for power-up
            await new Promise(resolve => setTimeout(resolve, 50));

            // Perform soft reset
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.SOFT_RESET);
            await new Promise(resolve => setTimeout(resolve, 50));

            // Initialize the reader
            await this.writeRegister(REGISTERS.TModeReg, 0x8D);        // TAuto=1; timer starts automatically at the end of the transmission
            await this.writeRegister(REGISTERS.TPrescalerReg, 0x3E);   // TModeReg[3..0] + TPrescalerReg defines the timer value
            await this.writeRegister(REGISTERS.TReloadRegL, 30);       // Reload timer with 30
            await this.writeRegister(REGISTERS.TReloadRegH, 0);        // Reload timer with 0
            await this.writeRegister(REGISTERS.TX_ASK, 0x40);          // Force 100% ASK modulation
            await this.writeRegister(REGISTERS.MODE, 0x3D);            // CRC Initial value 0x6363

            // Check version
            const version = await this.readRegister(REGISTERS.VERSION);
            this.logger.info('MFRC522 version:', version ? version.toString(16) : 'unknown');
            
            if (!version || version === 0xFF) {
                this.logger.error('Failed to initialize MFRC522. Invalid version or no response from device');
                return false;
            }

            // Turn on the antenna
            await this.antennaOn();
            
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

    async antennaOn() {
        try {
            const value = await this.readRegister(REGISTERS.TX_CONTROL);
            if (!(value & 0x03)) {
                await this.writeRegister(REGISTERS.TX_CONTROL, value | 0x03);
            }
        } catch (err) {
            this.logger.error('Error turning on antenna:', err);
        }
    }

    async checkCardPresence() {
        try {
            // Prepare for REQA command
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x07);    // TxLastBits = 7 means transmit only 7 bits
            await this.writeRegister(REGISTERS.FIFO_LEVEL, 0x80);     // Clear FIFO
            await this.writeRegister(REGISTERS.FIFO_DATA, 0x26);      // REQA command
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.TRANSCEIVE);
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x87);    // StartSend=1, transmission of data starts

            // Wait for completion
            let irqFlags;
            const startTime = Date.now();
            do {
                irqFlags = await this.readRegister(REGISTERS.COM_IRQ);
                if (Date.now() - startTime > 100) {
                    this.logger.debug('Card presence check timeout');
                    return false;
                }
            } while (!(irqFlags & 0x30) && !(irqFlags & 0x01));  // Wait for completion or timeout

            return (irqFlags & 0x20) !== 0;  // Return true if we received data
        } catch (err) {
            this.logger.error('Error checking card presence:', err);
            return false;
        }
    }

    async readCardUID() {
        try {
            // Send ANTICOLL command
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x00);
            await this.writeRegister(REGISTERS.FIFO_LEVEL, 0x80);
            
            // Write ANTICOLL command to FIFO
            await this.writeRegister(REGISTERS.FIFO_DATA, REGISTERS.ANTICOLL);
            await this.writeRegister(REGISTERS.FIFO_DATA, 0x20);
            
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.TRANSCEIVE);
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x80);  // StartSend=1

            // Wait for completion
            let irqFlags;
            const startTime = Date.now();
            do {
                irqFlags = await this.readRegister(REGISTERS.COM_IRQ);
                if (Date.now() - startTime > 100) {
                    return null;
                }
            } while (!(irqFlags & 0x30) && !(irqFlags & 0x01));

            if (!(irqFlags & 0x20)) {
                return null;
            }

            // Read the UID
            const length = await this.readRegister(REGISTERS.FIFO_LEVEL);
            if (length !== 5) {  // UID should be 4 bytes + BCC
                return null;
            }

            const uid = [];
            for (let i = 0; i < 4; i++) {
                uid.push(await this.readRegister(REGISTERS.FIFO_DATA));
            }

            return serializeUid(uid);
        } catch (err) {
            this.logger.error('Error reading card UID:', err);
            return null;
        }
    }

    writeRegister(register, value) {
        return new Promise((resolve, reject) => {
            if (!this.i2cBus) {
                reject(new Error('I2C bus not initialized'));
                return;
            }
            
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

    async watcher() {
        try {
            if (!this.i2cBus) {
                this.logger.error('I2C bus not initialized');
                return;
            }

            const cardPresent = await this.checkCardPresence();
            
            if (!cardPresent) {
                if (this.currentUID) {
                    if (this.debounceCounter >= this.debounceThreshold) {
                        this.onCardRemoved(this.currentUID);
                        this.currentUID = null;
                        this.debounceCounter = 0;
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