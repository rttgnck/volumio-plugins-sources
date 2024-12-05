'use strict';

const SerialPort = require('serialport');
const serializeUid = require('./serializeUid');

// PN532 Constants
const _PREAMBLE = 0x00;
const _STARTCODE1 = 0x00;
const _STARTCODE2 = 0xFF;
const _POSTAMBLE = 0x00;

const _HOSTTOPN532 = 0xD4;
const _PN532TOHOST = 0xD5;

const _COMMAND_GETFIRMWAREVERSION = 0x02;
const _COMMAND_SAMCONFIGURATION = 0x14;
const _COMMAND_INLISTPASSIVETARGET = 0x4A;

class PN532_UART {
    constructor(portName = '/dev/ttyS0', logger = console) {
        this.logger = logger;
        this.port = null;
        this.portName = portName;
    }

    async init() {
        try {
            // Open UART port at 115200 baud
            this.port = new SerialPort(this.portName, {
                baudRate: 115200,
                dataBits: 8,
                parity: 'none',
                stopBits: 1,
                flowControl: false
            });

            // Wait for port to open
            await new Promise((resolve, reject) => {
                this.port.on('open', resolve);
                this.port.on('error', reject);
            });

            this.logger.info(`Opened UART port ${this.portName}`);
            
            // Wake up PN532
            await this._wakeup();
            
            // Get firmware version
            const version = await this.getFirmwareVersion();
            if (!version) {
                this.logger.error("Couldn't get firmware version");
                return false;
            }

            this.logger.info('Found PN532 with firmware version:', version);

            // Configure SAM
            await this.SAMConfig();
            
            return true;
        } catch (err) {
            this.logger.error('Failed to initialize PN532:', err);
            return false;
        }
    }

    async _wakeup() {
        // Send wake up sequence
        await this._write(Buffer.from([0x55, 0x55, 0x00, 0x00, 0x00]));
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    async getFirmwareVersion() {
        try {
            const response = await this._writeCommand([_COMMAND_GETFIRMWAREVERSION]);
            if (!response || response.length < 4) return null;
            return {
                ic: response[0],
                ver: response[1],
                rev: response[2],
                support: response[3]
            };
        } catch (err) {
            this.logger.error('Error getting firmware version:', err);
            return null;
        }
    }

    async SAMConfig() {
        try {
            // Configure SAM to normal mode, timeout 50ms * 20 = 1 second
            const response = await this._writeCommand([
                _COMMAND_SAMCONFIGURATION,
                0x01, // Normal mode
                0x14, // Timeout 50ms * 20
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
            const response = await this._writeCommand([
                _COMMAND_INLISTPASSIVETARGET,
                0x01,  // Max targets
                0x00   // Baud rate (106 kbps type A)
            ]);

            if (!response || response.length < 7) return null;

            // Check if a card was found
            if (response[0] !== 0x01) return null;

            // Extract UID
            const uidLength = response[5];
            const uid = response.slice(6, 6 + uidLength);
            
            return uid;
        } catch (err) {
            this.logger.error('Error reading passive target:', err);
            return null;
        }
    }

    async _writeCommand(command) {
        const frame = Buffer.from([
            _PREAMBLE,
            _STARTCODE1,
            _STARTCODE2,
            command.length + 1,
            -(command.length + 1),
            _HOSTTOPN532,
            ...command
        ]);

        // Add checksum
        let sum = command.reduce((a, b) => a + b, _HOSTTOPN532);
        frame.push(-sum & 0xFF);
        frame.push(_POSTAMBLE);

        await this._write(frame);
        
        // Wait for ACK
        const ack = await this._read(6);
        if (!ack || ack.length !== 6) {
            throw new Error('No ACK received');
        }

        // Read response
        const response = await this._read(command.length + 7);
        if (!response) return null;

        // Return data without headers
        return response.slice(6, -2);
    }

    async _write(data) {
        return new Promise((resolve, reject) => {
            this.port.write(data, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async _read(length) {
        return new Promise((resolve) => {
            this.port.once('data', (data) => {
                resolve(data);
            });
            // Add timeout
            setTimeout(() => resolve(null), 1000);
        });
    }

    close() {
        if (this.port) {
            this.port.close();
            this.port = null;
        }
    }
}

class NFCDaemon {
    constructor(portName = '/dev/ttyS0', onCardDetected, onCardRemoved, logger = console, interval = 500, debounceThreshold = 5) {
        this.interval = interval;
        this.logger = logger;
        
        this.intervalHandle = null;
        this.currentUID = null;
        this.debounceCounter = 0;
        this.isFirstRead = true;
        
        this.onCardDetected = onCardDetected;
        this.onCardRemoved = onCardRemoved;
        this.debounceThreshold = debounceThreshold;
        
        this.reader = new PN532_UART(portName, logger);
        this.watcher = this.watcher.bind(this);
    }

    async start() {
        try {
            this.logger.info('NFC Daemon: Initializing...');
            const initialized = await this.reader.init();
            if (!initialized) {
                this.logger.error('Failed to initialize NFC reader');
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
            const uid = await this.reader.readPassiveTargetID();
            
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
                await this.reader.init();
            } catch (e) {
                this.logger.error('Error reinitializing:', e);
            }
        }
    }
}

module.exports = NFCDaemon;