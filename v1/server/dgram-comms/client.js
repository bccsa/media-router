const Socket = require("./socket");
const ClientServerBase = require("./clientServerBase");
const decipher = require("./encryption").decrypt;

// ===========================
// Client Class

class Client extends ClientServerBase {
    /**
     *  Setup udp socket connection to server
     * @param {Object} param0 - port, address, clientID, encryptionKey
     */
    constructor({
        port,
        address,
        clientID,
        encryptionKey,
        connectionTimeout,
        retryTimeout,
        missedKeepaliveThreshold,
    }) {
        super({ connectionTimeout, retryTimeout });
        this.socket = undefined;
        this.port = port || 41234;
        this.address = address || "localhost";
        this.clientID = clientID;
        this.encryptionKey = encryptionKey;
        this.connectionTimeout = connectionTimeout || 5000; // 5 seconds (increased from 1s)
        this.missedKeepaliveThreshold = missedKeepaliveThreshold || 3;
        this.connectionInterval = undefined;
        this._connectPending = false;

        this.socket = new Socket({
            port,
            address,
            serverSocket: this.server,
            isClient: true,
            clientID,
            encryptionKey,
            retryTimeout: this.retryTimeout,
            connectionTimeout: this.connectionTimeout,
            missedKeepaliveThreshold: this.missedKeepaliveThreshold,
            parentDisconnect: this.disconnect.bind(this),
        });

        this.setupConnection();
        // this.connectionWatchDog();
        this.connectionRetry();
    }

    /**
     * return a socket
     */
    getSocket() {
        return this.socket;
    }

    setupConnection() {
        if (this._connectPending) return;
        this._connectPending = true;
        // setup connection
        this.socket.emit(null, null, {
            type: "connect",
            socketID: this.socket.socketID,
        });
        this.socket.deleted = false;
    }

    connected({ data }) {
        this._connectPending = false;
        // start keepAlive
        this.socket._keepalive();
        // set socketID
        this.socket.socketID = data.socketID;
        // emit data event
        this.socket.emitLocal("connected", data.message);
    }

    disconnect() {
        this.socket.connected = false;
    }

    /**
     * Try to reconnect as long as socket is disconnected
     */
    connectionRetry() {
        this.connectionInterval = setInterval(() => {
            if (!this.socket.connected) {
                // reset pending flag so a new attempt can be made
                this._connectPending = false;
                this.setupConnection();
            }
        }, this.connectionTimeout);
    }

    /**
     * Client Decryption handling
     * @param {*} data
     * @param {*} iv
     * @param {*} clientID
     */
    async decrypt(data, iv, clientID) {
        // ignore message if encryption key is not provided
        if (clientID && iv && !this.encryptionKey) return;
        return await decipher(data, iv, this.encryptionKey);
    }

    /**
     * destroys all intervals and disconnects socket
     */
    destroy() {
        clearInterval(this.connectionInterval);
        this.socket.disconnect();
        this.socket.removeAllListeners();
    }
}

module.exports = Client;
