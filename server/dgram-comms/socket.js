const { v4: uuidv4 } = require("uuid");
const { waitingAck } = require("./data");
const { encrypt } = require("./encryption");
const Events = require("events").EventEmitter;
const messageFragmentation = require("./messageFragmentation");

/**
 * Used to give a unique id to each ack message
 */
let ackCounter = 0;

// ===========================
// Socket Class
/**
 * dgram udp socket used for server to server communication
 */
class Socket extends Events {
    /**
     *
     * @param {Object} options - serverPort, serverAddress
     */
    constructor({
        port,
        address,
        serverSocket,
        isClient = false,
        clientID = undefined,
        encryptionKey = undefined,
        retryTimeout,
        connectionTimeout,
        parentDisconnect,
    }) {
        super();
        this.socketID = !isClient ? uuidv4() : "";
        this.isClient = isClient;
        this.socket = serverSocket;
        this.port = port;
        this.address = address;
        this.deleted = false;
        this.keepAliveTime = new Date();
        this.keepAlive = undefined;
        this.connected = false;
        this.clientID = clientID; // used to identify client
        this.encryptionKey = encryptionKey; // used to encrypt/decrypt messages
        this.retryTimeout = retryTimeout || 500;
        this.connectionTimeout = connectionTimeout || 1000; // 1 seconds
        this.frag = new messageFragmentation(this.socket);
        this.parentDisconnect = parentDisconnect;

        this.on("connected", () => {
            this.connected = true;
        });
        this.on("disconnected", () => {
            this.connected = false;
        });

        this._keepalive();
    }

    // start client keepAlive
    _keepalive() {
        if (this.keepAlive) return;
        this.keepAlive = setInterval(() => {
            this.connectionWatchDog();
        }, this.connectionTimeout / 4);
    }

    /**
     * emit a message to a socket
     * @param {String} topic
     * @param {Any} message
     * @param {Object} options - type (data (default), keepAlive, ack), guaranteeDelivery (used for guaranteed delivery)
     */
    emit(topic, message, options = {}) {
        this._emit(
            this.socket,
            this.port,
            this.address,
            topic,
            message,
            options
        );
    }

    /**
     * emit a message to a socket
     * @param {Object} _dgram - udp socket
     * @param {Number} port - destination port
     * @param {String} address - destination address
     * @param {String} topic - topic
     * @param {Any} message - message
     * @param {Object} options - type (data (default), keepAlive, ack), guaranteeDelivery (used for guaranteed delivery), ackID (used for guaranteed delivery), socketID
     */
    async _emit(_dgram, port, address, topic, message, options) {
        // wait socket to get a socketID
        while (!this.socketID && options.type != "connect") {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // create guaranteeDelivery
        if (!options.ackID && options.guaranteeDelivery) {
            ackCounter++;
            options.ackID = ackCounter;
        }

        let data = {
            topic: topic,
            message: message,
            ackID: options.ackID,
            socketID: this.socketID,
        };

        // encrypt data if encryptionKey is provided
        if (
            this.clientID &&
            this.encryptionKey &&
            (!options.type ||
                options.type == "data" ||
                options.type == "connect")
        ) {
            data = await encrypt(JSON.stringify(data), this.encryptionKey);
        }

        const M = JSON.stringify({
            type: options.type || "data",
            data: data.encryptedData || data,
            iv: data.iv,
            clientID: this.clientID,
        });

        this.frag.sendFragmentedMessage(M, port, address);

        // if guaranteeDelivery is true, add message to waitingAck
        options.guaranteeDelivery &&
            this.waitForAck(_dgram, port, address, topic, message, options);
    }

    /**
     * Wait for ack from socket
     * @param {Object} _dgram - udp socket
     * @param {Number} port - destination port
     * @param {String} address - destination address
     * @param {String} topic - topic
     * @param {Any} message - message
     * @param {Object} options - type (data (default), keepAlive, ack), guaranteeDelivery (used for guaranteed delivery), ackID (used for guaranteed delivery), socketID
     */
    waitForAck(_dgram, port, address, topic, message, options) {
        waitingAck[options.ackID] = { ackID: options.ackID };
        // wait for 2 seconds for ack
        setTimeout(() => {
            if (waitingAck[options.ackID] && !this.deleted) {
                // re-emit message
                this._emit(_dgram, port, address, topic, message, {
                    ...options,
                    socketID: this.socketID,
                });
            }
        }, this.retryTimeout);
    }

    /**
     * Disconnect socket
     */
    disconnect() {
        clearInterval(this.keepAlive);
        this.keepAlive = undefined;
        this.parentDisconnect(this.socketID);
        this.emitLocal("disconnected", this.socketID);
        if (!this.isClient) this.removeAllListeners(); // only remove listener if client
        console.log("disconnecting socket: " + this.socketID);
        this.deleted = true;
        this.connected = false;
    }

    /**
     * Connection WatchDog
     */
    connectionWatchDog() {
        this.emit(null, null, { type: "keepAlive" });
        // check if connection is alive
        if (new Date() - this.keepAliveTime > this.connectionTimeout) {
            this.disconnect();
        }
    }

    /**
     * Emit an event with eventemitter
     * @param {string} eventName
     * @param {Any} data
     */
    emitLocal(eventName, data) {
        super.emit(eventName, data);
    }
}

module.exports = Socket;
