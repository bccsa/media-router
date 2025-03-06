const dgram = require("dgram");
const { waitingAck } = require("./data");
const Events = require("events").EventEmitter;

// ===========================
// Client server base class

/**
 * dgram udp server used for server to server communication
 */
class ClientServerBase extends Events {
    /**
     * @param {Object} options - port(default: 41234), encryptionKeys)
     */
    constructor({ connectionTimeout, retryTimeout }) {
        super();
        this.server = dgram.createSocket("udp4");
        this.connectionTimeout = connectionTimeout || 5000; // 5 seconds
        this.retryTimeout = retryTimeout || 500; // 500 ms

        this.server.on("message", this.messageHandler.bind(this));

        this.server.on("error", (err) => {
            console.error(`Server error: ${err.stack}`);
            this.server.close();
        });
    }

    // =========
    // Handlers

    /**
     * Handle incoming messages format: Handle incoming messages format: (see: messageStructure)
     * message should be in JSON format
     * @param {string} msg - message from socket
     * @param {*} rinfo
     */
    async messageHandler(msg, rinfo) {
        let m = msg.toString();
        try {
            m = JSON.parse(msg);
        } catch (e) {
            console.error("Error parsing message: ", e);
            return;
        }
        let { data } = m;
        const { type, clientID, iv } = m;

        if (clientID && iv) {
            data = await this.decrypt(data, iv, clientID);
            if (!data) return;
            data = JSON.parse(data);
        }

        // return ackID to client to guarantee delivery
        const socket = this.getSocket(data.socketID);
        data &&
            type !== "ack" &&
            data.ackID &&
            socket &&
            socket.emit("ack", null, {
                type: "ack",
                ackID: data.ackID,
            });

        this[type] && this[type]({ ...m, ...{ data }, ...{ rinfo } });
    }

    keepAlive({ data }) {
        // update keepAliveTime
        const socket = this.getSocket(data.socketID);
        data && socket && (socket.keepAliveTime = new Date());
    }

    data({ data }) {
        // emit data event
        const socket = this.getSocket(data.socketID);
        data && socket && socket.emitLocal(data.topic, data.message);
    }

    ack({ data }) {
        // remove message from waitingAck
        data && delete waitingAck[data.ackID];
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

module.exports = ClientServerBase;
