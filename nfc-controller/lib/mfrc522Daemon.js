'use strict';

const i2c = require('i2c-bus');
const serializeUid = require('./serializeUid');

class SimpleMFRC522 {
    constructor(busNumber = 1, address = 0x24, logger = console) {
        this.address = address;
        this.busNumber = busNumber;
        this.logger = logger;
        this.bus = null;
    }

    async init() {
        try {
            this.bus = await i2c.openPromisified(this.busNumber);
            this.logger.info(`Opened I2C bus ${this.busNumber}`);
            
            // Clear any pending data by doing an initial read
            await this.readCard();
            // Small delay to ensure the reader is stable
            await new Promise(resolve => setTimeout(resolve, 100));
            
            return true;
        } catch (err) {
            this.logger.error('Failed to open I2C bus:', err);
            return false;
        }
    }

    async readCard() {
        if (!this.bus) {
            throw new Error('I2C bus not initialized');
        }

        try {
            // Read card ID (4 bytes)
            const buffer = Buffer.alloc(4);
            await this.bus.i2cRead(this.address, buffer.length, buffer);
            this.logger.info('Read buffer:', buffer);

            // Check if all bytes are 0 or all bytes are 255 (common no-card states)
            const isAllZero = buffer.every(byte => byte === 0);
            const isAllFF = buffer.every(byte => byte === 0xFF);
            this.logger.info('Buffer check - All Zero:', isAllZero, 'All FF:', isAllFF);
            
            if (isAllZero || isAllFF) {
                this.logger.warn('No card detected (all bytes are zero or 255)');
                return null;
            }

            // return serializeUid(Array.from(buffer));
            return null;
        } catch (err) {
            this.logger.error('Error reading card:', err.message);
            return null;
        }
    }

    async close() {
        if (this.bus) {
            try {
                await this.bus.close();
                this.bus = null;
            } catch (err) {
                this.logger.error('Error closing I2C bus:', err);
            }
        }
    }
}

class MFRC522Daemon {
    constructor(i2cBusNumber = 1, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        this.interval = interval;
        this.logger = logger;
        this.i2cBusNumber = i2cBusNumber;
        
        this.intervalHandle = null;
        this.currentUID = null;
        this.debounceCounter = 0;
        this.isFirstRead = true;
        
        this.onCardDetected = onCardDetected;
        this.onCardRemoved = onCardRemoved;
        this.debounceThreshold = debounceThreshold;
        
        this.reader = new SimpleMFRC522(i2cBusNumber, 0x24, logger);
        this.watcher = this.watcher.bind(this);
    }

    async start() {
        try {
            this.logger.info('NFC Daemon: Initializing...');
            const initialized = await this.reader.init();
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
        if (this.reader) {
            this.reader.close().catch(err => {
                this.logger.error('Error closing reader:', err);
            });
        }
    }

    async watcher() {
        try {
            const uid = await this.reader.readCard();
            
            // Skip the first read after initialization
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
            if (err.code === 'ENODEV' || err.code === 'EIO') {
                this.logger.info('Attempting to reinitialize reader...');
                await this.reader.init();
            }
        }
    }
}

module.exports = MFRC522Daemon;