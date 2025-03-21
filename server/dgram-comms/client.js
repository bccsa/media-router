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
    }) {
        super({ connectionTimeout, retryTimeout });
        this.socket = undefined;
        this.port = port || 41234;
        this.address = address || "localhost";
        this.clientID = clientID;
        this.encryptionKey = encryptionKey;
        this.connectionTimeout = connectionTimeout || 1000; // 1 seconds

        this.socket = new Socket({
            port,
            address,
            serverSocket: this.server,
            isClient: true,
            clientID,
            encryptionKey,
            retryTimeout: this.retryTimeout,
            connectionTimeout: this.connectionTimeout,
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
        // setup connection
        this.socket.emit(null, null, {
            type: "connect",
            socketID: this.socket.socketID,
        });
    }

    connected({ data }) {
        // start keepAlive
        this.socket._keepalive();
        // set socketID
        this.socket.socketID = data.socketID;
        // emit data event
        this.socket.emitLocal(data.topic, data.message);
    }

    disconnect() {
        this.socket.connected = false;
    }

    /**
     * Try to reconnect as long as socket is disconnected
     */
    connectionRetry() {
        setInterval(() => {
            // try to setupConnection as log as socket is disconnected
            if (!this.socket.connected) this.setupConnection();
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
}

module.exports = Client;
