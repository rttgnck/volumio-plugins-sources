'use strict';

const Mfrc522 = require('mfrc522-rpi');
const serializeUid = require('./serializeUid');

/* 
	Mifare RC522 is connected to the SPI bus. As far as I've seen, 
	there's no option to implement an interrupt-mechanism there, but only 
	a polling is possible => we'll read (poll) the bus and write the result 
	into a file. To this file handler, we'll attach a callback triggering 
	the actual logic
	*/
class MFRC522Daemon {
    constructor(spiChannel, onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        // Initialize MFRC522 with SPI channel
        const mfrc522 = new Mfrc522(spiChannel);

        const self = this;

        self.interval = interval;
        self.logger = logger;
        self.mfrc522 = mfrc522;

        self.intervalHandle = null;
        self.currentUID = null;

        self.watcher = function () {
            //# reset card
            self.mfrc522.reset();

            //# Scan for cards
            let response = self.mfrc522.findCard();
            //self.logger.info('NFC reader daemon:', JSON.stringify(response));
            if (!response.status) {
                if (self.currentUID) {
                    if (self.debounceCounter >= debounceThreshold) {
                        onCardRemoved(self.currentUID);
                        self.currentUID = null;
                    } else {
                        self.debounceCounter++;
                    }
                }
            } else {
                const uid = serializeUid(self.mfrc522.getUid().data);
                self.debounceCounter = 0;
                if (!self.currentUID || self.currentUID !== uid) {
                    self.currentUID = uid;
                    onCardDetected(self.currentUID);
                }
            }
        }
    }

    start() {
        this.logger.info('NFC Daemon:', `going to poll the reader every ${this.interval}ms`);
        this.intervalHandle = setInterval(this.watcher, this.interval);
    }

    stop() {
        clearInterval(this.intervalHandle);
    }
}

module.exports = MFRC522Daemon;
