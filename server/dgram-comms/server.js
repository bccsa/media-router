const Socket = require("./socket");
const ClientServerBase = require("./clientServerBase");
const decipher = require("./encryption").decrypt;

// ===========================
// Server Class

/**
 * dgram udp server used for server to server communication
 */
class Server extends ClientServerBase {
    /**
     * @param {Object} options - port(default: 41234), bindAddress(default: "0.0.0.0")
     */
    constructor({
        bindAddress,
        port,
        encryptionKeys = {},
        enforceEncryption = false,
        connectionTimeout = 5000,
        retryTimeout = 500,
    }) {
        super({ connectionTimeout, retryTimeout });
        this.sockets = {};
        this.bindAddress = bindAddress || "0.0.0.0";
        this.port = port || 41234;
        this.encryptionKeys = encryptionKeys; // used to encrypt/decrypt messages format {[clientID]: key}
        this.enforceEncryption = enforceEncryption;

        this.server.on("listening", () => {
            const address = this.server.address();
            console.log(
                `Server listening on ${address.address}:${address.port}`
            );
        });

        this.server.bind(port, bindAddress, () => {
            this.server.setSendBufferSize(65507); // Max UDP packet size
        });
        setInterval(() => {
            this.connectionWatchDog();
        }, connectionTimeout / 4);
    }

    /**
     * emit a message to a socket
     * @param {String} topic
     * @param {Any} message
     * @param {Object} options - type (data (default), keepAlive, ack), guaranteeDelivery (used for guaranteed delivery)
     */
    emit(topic, message, options) {
        for (const _socket of Object.values(this.sockets)) {
            _socket.emit(topic, message, options);
        }
    }

    // =========
    // Server Only handlers Handlers

    /**
     * Setup a connection to client
     * @param {*} param0
     */
    connect({ data, rinfo, clientID }) {
        data &&
            !this.sockets[data.socketID] &&
            rinfo &&
            this.setupSocket({ data, rinfo, clientID });
    }

    /**
     * Setup a new socket
     * @param {Object} rinfo
     */
    setupSocket({ rinfo, clientID }) {
        // ignore connection if encryption is enabled and key is not found
        if (this.enforceEncryption && !this.encryptionKeys[clientID]) return;
        const _s = new Socket({
            port: rinfo.port,
            address: rinfo.address,
            serverSocket: this.server,
            clientID: clientID,
            encryptionKey: this.encryptionKeys[clientID],
            retryTimeout: this.retryTimeout,
        });

        this.sockets[_s.socketID] = _s;

        _s.emit("connected", _s.socketID, {
            type: "connected",
            guaranteeDelivery: true,
        });
        this.emitLocal("connected", _s);
    }

    /**
     * Check if socket is still connected
     */
    connectionWatchDog() {
        Object.values(this.sockets).forEach((s) => {
            s.emit(null, null, { type: "keepAlive" });
            const now = new Date();
            if (now - s.keepAliveTime > this.connectionTimeout) {
                // remove socket
                s.deleted = true;
                clearInterval(s.keepAlive);
                delete this.sockets[s.socketID];
                // emit offline event
                s.emitLocal("disconnected", s.socketID);
                s = undefined;
            }
        });
    }

    /**
     * Server Decryption handling
     * @param {*} data
     * @param {*} iv
     * @param {*} clientID
     */
    async decrypt(data, iv, clientID) {
        // ignore message if encryption key is not provided
        if (clientID && iv && !this.encryptionKeys[clientID]) return;
        return await decipher(data, iv, this.encryptionKeys[clientID]);
    }

    /**
     * Return socket based on socket ID
     */
    getSocket(socketID) {
        return this.sockets[socketID];
    }
}

module.exports = Server;
