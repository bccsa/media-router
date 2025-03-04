# Data Gram Comms

`dgram-comms` is a UDP server-to-server implementation used for communication over UDP with the possibility of guaranteed message delivery. The implementation is similar to `socket.io`, with some minor differences.

## Usage

### Client Side

```javascript
const { Client } = require("./dgram-comms");

const clientA = new Client({
    port: 41234, // default: 41234
    address: "localhost", // default: "localhost"
    encryptionKey: "key1", // used to encrypt comms between server and client (optional)
    clientID: "client1", // used to identify client on server side and determine which key to use for decryption (optional)
    connectionTimeout, // how long the socket should wait to disconnect if no keepAlive message is received from the server
    retryTimeout, // how long the client should wait to retry sending a message if no acknowledgment is received
});

const socket = clientA.getSocket();

socket.on("connected", (msg) => {
    console.log(`Client connected: ${msg}`);
});

socket.on("disconnected", (msg) => {
    console.log(`Client disconnected: ${msg}`);
});

// Listen to messages from the server
socket.on("test", (msg) => {
    console.log(`test: ${msg}`);
});

// Listen to messages from the server
socket.on("hello", (msg) => {
    console.log(`hello: ${msg}`);
});

// Send a test message to the server
socket.emit("test", "Hello from client", { guaranteeDelivery: true });
// If guaranteeDelivery is enabled, the client will retry sending the message until it receives a confirmation from the server

// Send a "hello world" message to the server
socket.emit("hello", "Hello world client");
```

### Server Side

```javascript
const { Server } = require("./dgram-comms");

const serverA = new Server({
    port: 41234, // default: 41234
    bindAddress: "0.0.0.0", // default: "0.0.0.0"
    encryptionKeys: {
        // optional, but if provided, all client connections require a valid clientID/key pair matching the server
        client1: "key1",
    },
    enforceEncryption: true, // enforce encrypted communication
    connectionTimeout, // how long the socket should wait to disconnect if no keepAlive message is received from the client
    retryTimeout, // how long the server should wait to retry sending a message if no acknowledgment is received
});

serverA.on("connected", (socket) => {
    socket.on("disconnected", (msg) => {
        console.log(`Server disconnect: ${msg}`);
    });
    console.log(`Server connected: ${socket.socketID}`);

    // Send a test message to the client with guaranteed delivery
    socket.emit("test", "Hello from server", { guaranteeDelivery: true });
    // If guaranteeDelivery is enabled, the server will retry sending the message until it receives a confirmation from the client

    // Listen to a test message from the client
    socket.on("test", (msg) => {
        console.log(`test: ${msg}`);
    });

    // Send a "hello world" message to the client
    socket.emit("hello", "Hello world server");

    // Listen to a "hello" message from the client
    socket.on("hello", (msg) => {
        console.log(`hello: ${msg}`);
    });
});
```
