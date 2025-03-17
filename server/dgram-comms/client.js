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
        });

        this.setupConnection();
        this.connectionWatchDog();
        this.connectionRetry();

        // retry connection when loosing connection
        this.socket.on("disconnect", (msg) => {
            this._setupConnection();
        });
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
        // set socketID
        this.socket.socketID = data.socketID;
        // emit data event
        this.socket.emitLocal(data.topic, data.message);
    }

    /**
     * Check if socket is still connected
     */
    connectionWatchDog() {
        this.socket.keepAlive = setInterval(() => {
            this.socket.emit(null, null, { type: "keepAlive" });
            const now = new Date();
            if (
                now - this.socket.keepAliveTime > this.connectionTimeout &&
                this.socket.connected
            ) {
                // emit offline event
                this.socket.emitLocal("disconnected", this.socket.socketID);
            }
        }, this.connectionTimeout / 4);
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
