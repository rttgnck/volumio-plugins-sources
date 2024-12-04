'use strict';

const i2c = require('i2c-bus');
const serializeUid = require('./serializeUid');

// MFRC522 Register addresses
const REGISTERS = {
    COMMAND: 0x01,
    COM_IRQ: 0x04,
    FIFO_LEVEL: 0x0A,
    FIFO_DATA: 0x09,
    STATUS2: 0x08,
    BIT_FRAMING: 0x0D,
    COLL: 0x0E,
    MODE: 0x11,
    TX_MODE: 0x12,
    RX_MODE: 0x13,
    TX_CONTROL: 0x14,
    TX_ASK: 0x15,
    VERSION: 0x37
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

/*
    Using MFRC522 over I2C bus instead of SPI.
    Still implementing polling mechanism since interrupts aren't reliable.
*/
class MFRC522Daemon {
    constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        // Initialize I2C bus
        const i2cBus = i2c.openSync(i2cBusNumber);
        
        // MFRC522 default I2C address is 0x28
        const i2cAddress = 0x24; //ours is 0x24, sudo i2cdetect -y 1

        const self = this;

        self.interval = interval;
        self.logger = logger;
        self.i2cBus = i2cBus;
        self.i2cAddress = i2cAddress;

        self.intervalHandle = null;
        self.currentUID = null;
        self.debounceCounter = 0;

        self.watcher = function () {
            try {
                // Read card presence by checking if a card is in the field
                const cardPresent = self.checkCardPresence();
                
                if (!cardPresent) {
                    if (self.currentUID) {
                        if (self.debounceCounter >= debounceThreshold) {
                            onCardRemoved(self.currentUID);
                            self.currentUID = null;
                        } else {
                            self.debounceCounter++;
                        }
                    }
                } else {
                    const uid = self.readCardUID();
                    if (uid) {
                        self.debounceCounter = 0;
                        if (!self.currentUID || self.currentUID !== uid) {
                            self.currentUID = uid;
                            onCardDetected(self.currentUID);
                        }
                    }
                }
            } catch (err) {
                self.logger.error('Error reading MFRC522:', err);
            }
        }
    }

    async init() {
        try {
            // Perform soft reset
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.SOFT_RESET);
            
            // Wait for reset to complete
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // Check if the reader is responding
            const version = await this.readRegister(REGISTERS.VERSION);
            if (version === 0x91 || version === 0x92) {
                this.logger.info('MFRC522 initialized successfully. Version:', version.toString(16));
                return true;
            } else {
                this.logger.error('Failed to initialize MFRC522. Invalid version:', version.toString(16));
                return false;
            }
        } catch (err) {
            this.logger.error('Error initializing MFRC522:', err);
            return false;
        }
    }

    async writeRegister(register, value) {
        try {
            await this.i2cBus.writeByte(this.i2cAddress, register, value);
        } catch (err) {
            this.logger.error(`Error writing to register ${register.toString(16)}:`, err);
            throw err;
        }
    }

    async readRegister(register) {
        try {
            return await this.i2cBus.readByte(this.i2cAddress, register);
        } catch (err) {
            this.logger.error(`Error reading from register ${register.toString(16)}:`, err);
            throw err;
        }
    }

    async checkCardPresence() {
        try {
            // Enable antenna
            let value = await this.readRegister(REGISTERS.TX_CONTROL);
            if ((value & 0x03) !== 0x03) {
                await this.writeRegister(REGISTERS.TX_CONTROL, value | 0x03);
            }

            // Send REQA command
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x07);    // TxLastBits = 7
            await this.writeRegister(REGISTERS.FIFO_DATA, 0x26);      // REQA command
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.TRANSCEIVE);
            
            // Wait for response
            const status = await this.readRegister(REGISTERS.COM_IRQ);
            return (status & 0x20) !== 0; // Check if a card responded
        } catch (err) {
            this.logger.error('Error checking card presence:', err);
            return false;
        }
    }

    async readCardUID() {
        try {
            // Send anti-collision command
            await this.writeRegister(REGISTERS.BIT_FRAMING, 0x00);
            await this.writeRegister(REGISTERS.FIFO_DATA, 0x93);  // Anti-collision command
            await this.writeRegister(REGISTERS.COMMAND, COMMANDS.TRANSCEIVE);

            // Read response
            const uidLength = await this.readRegister(REGISTERS.FIFO_LEVEL);
            if (uidLength !== 5) { // UID + BCC
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

    start() {
        this.logger.info('NFC Daemon:', `going to poll the reader every ${this.interval}ms`);
        this.intervalHandle = setInterval(this.watcher, this.interval);
    }

    stop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
        }
        if (this.i2cBus) {
            this.i2cBus.closeSync();
        }
    }
}

module.exports = MFRC522Daemon;
