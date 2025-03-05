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
            guaranteeDelivery: true,
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
                this.setupConnection();
            }
        }, 250);
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

// const Client = {
//     _s: undefined,
//     _socket: undefined,
//     /**
//      * Create a new socket
//      * @param {Object} options - port, address
//      */
//     createSocket({ port, address, clientID, encryptionKey }) {
//         this._s = dgram.createSocket("udp4");
//         this._s.on("message", this._messageHandler.bind(this));

//         this._s.on("error", (err) => {
//             console.error(`Server error: ${err.stack}`);
//             this._s.close();
//         });

//         this._socket = new Socket({
//             port,
//             address,
//             serverSocket: this._s,
//             isClient: true,
//             clientID,
//             encryptionKey,
//         });

//         this._setupConnection();
//         this.connectionWatchDog();

//         // retry connection when loosing connection
//         this._socket.event.on("disconnect", (msg) => {
//             this._setupConnection();
//         });

//         return this._socket;
//     },

//     _setupConnection() {
//         // setup connection
//         this._socket.emit(null, null, {
//             type: "connect",
//             guaranteeDelivery: true,
//             socketID: this._socket.socketID,
//         });
//     },

//     /**
//      * Handle incoming messages format: (see: messageStructure)
//      * message should be in JSON format
//      * @param {string} msg - message from socket
//      */
//     _messageHandler(msg) {
//         let m = msg.toString();
//         try {
//             m = JSON.parse(msg);
//         } catch (e) {
//             console.error("Error parsing message: ", e);
//             return;
//         }

//         const { type, data } = m;

//         // return ackID to client to guarantee delivery
//         data &&
//             data.ackID &&
//             this._socket &&
//             this._socket.emit("ack", null, {
//                 type: "ack",
//                 ackID: data.ackID,
//             });

//         this[type] && this[type](m);
//     },

//     keepAlive({ data }) {
//         // update keepAliveTime
//         data && this._socket && (this._socket.keepAliveTime = new Date());
//     },

//     data({ data }) {
//         // emit data event
//         this._socket.event.emit(data.topic, data.message);
//     },

//     ack({ data }) {
//         // remove message from waitingAck
//         delete waitingAck[data.ackID];
//     },

//     connected({ data }) {
//         // set socketID
//         this._socket.socketID = data.socketID;
//         // emit data event
//         this._socket.event.emit(data.topic, data.message);
//     },

//     /**
//      * Check if socket is still connected
//      */
//     connectionWatchDog() {
//         this._socket.keepAlive = setInterval(() => {
//             this._socket.emit(null, null, { type: "keepAlive" });
//             const now = new Date();
//             if (
//                 now - this._socket.keepAliveTime > 2000 &&
//                 this._socket.connected
//             ) {
//                 // emit offline event
//                 this._socket.event.emit("disconnected", this._socket.socketID);
//                 this._setupConnection();
//             }
//         }, 250);
//     },
// };

module.exports = Client;
