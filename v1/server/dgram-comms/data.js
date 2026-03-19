// ===========================
// Data Structures
// ===========================
const types = {
    keepAlive: "keepAlive", // used to keep track of active sockets
    data: "data", // default topic
    ack: "ack", // used to guarantee delivery as far as posable
    connect: "connect", // send a connection request, setup a socket
    connected: "connected", // send a connection confirmation, to socket
};

const messageStructure = {
    type: types,
    clientID: "string", // used to identify client (Not required)
    iv: "string", // used for encryption
    data: {
        topic: "string", // topic of message
        message: "any", // structure defined by emitter
        ackID: "ackID", // used to guarantee delivery as far as posable (Not required)
        socketID: "socketID", // used to identify the socket
    },
};

// ===========================
// runtime variables
// ===========================
/**
 * Used to keep track of messages that require an ack
 * @type {Object.<number, ackID>}
 */
const waitingAck = {};

module.exports = {
    types,
    messageStructure,
    waitingAck,
};
