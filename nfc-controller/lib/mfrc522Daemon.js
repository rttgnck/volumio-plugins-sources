'use strict';

const Mfrc522 = require('mfrc522-rpi');
const serializeUid = require('./serializeUid');

class MFRC522Daemon {
    constructor(spiChannel = 0, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        this.interval = interval;
        this.logger = logger;
        this.spiChannel = spiChannel;
        
        this.logger.info(`MFRC522Daemon: Using SPI channel ${spiChannel}`);
        
        this.intervalHandle = null;
        this.currentUID = null;
        this.debounceCounter = 0;
        
        this.onCardDetected = onCardDetected;
        this.onCardRemoved = onCardRemoved;
        this.debounceThreshold = debounceThreshold;
        
        this.mfrc522 = null;
        this.watcher = this.watcher.bind(this);
    }

    async init() {
        try {
            this.logger.info('Initializing MFRC522 reader...');
            
            // Initialize the MFRC522 with the specified SPI channel
            this.mfrc522 = new Mfrc522(this.spiChannel).setResetPin(22); // GPIO 22 for reset
            
            // Test if the reader is responding
            const version = this.mfrc522.getVersion();
            this.logger.info('MFRC522 version:', version.toString(16));
            
            if (!version || version === 0x00 || version === 0xFF) {
                this.logger.error('Failed to initialize MFRC522. Invalid version or no response from device');
                return false;
            }

            this.logger.info('MFRC522 initialized successfully');
            return true;

        } catch (err) {
            this.logger.error('Error initializing MFRC522:', err);
            return false;
        }
    }

    async checkCardPresence() {
        try {
            // Reset the card present status
            this.mfrc522.reset();
            
            // Check if a card is present
            return this.mfrc522.cardPresent();
        } catch (err) {
            this.logger.error('Error checking card presence:', err);
            return false;
        }
    }

    readCardUID() {
        try {
            // Find card and get its UID
            const response = this.mfrc522.findCard();
            if (!response.status) {
                return null;
            }

            const uid = this.mfrc522.getUid();
            if (!uid.status) {
                return null;
            }

            return serializeUid(uid.data);
        } catch (err) {
            this.logger.error('Error reading card UID:', err);
            return null;
        }
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
        if (this.mfrc522) {
            try {
                this.mfrc522.reset();
            } catch (err) {
                this.logger.error('Error stopping MFRC522:', err);
            }
            this.mfrc522 = null;
        }
    }

    async watcher() {
        try {
            if (!this.mfrc522) {
                this.logger.error('MFRC522 not initialized');
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
                const uid = this.readCardUID();
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
            await this.init();
        }
    }
}

module.exports = MFRC522Daemon;