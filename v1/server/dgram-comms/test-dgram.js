// const dgram = require("dgram");
const { Server, Client } = require("./index");

// =======================================
// Server
// =======================================
const serverA = new Server({
    port: 3000,
    encryptionKeys: {
        client1: "key1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
});

serverA.on("connected", (socket) => {
    socket.on("disconnected", (msg) => {
        console.log(`Server disconnect: ${msg}`);
    });
    console.log(`Server connected: ${socket.socketID}`);

    socket.emit("test", "Hello from server", { guaranteeDelivery: true });

    socket.on("test", (msg) => {
        console.log(`test: ${msg}`);
    });

    socket.emit("hello", "Hello world server");

    socket.on("hello", (msg) => {
        console.log(`hello: ${msg}`);
    });
});

// =======================================
// Client
// =======================================
const clientA = new Client({
    port: 3000,
    address: "localhost",
    encryptionKey: "key1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientID: "client1",
});

socket = clientA.getSocket();

socket.emit("data", "Hello");

socket.on("connected", (msg) => {
    console.log(`Client connected: ${msg}`);
});

socket.on("test", (msg) => {
    console.log(`test: ${msg}`);
});

socket.on("hello", (msg) => {
    console.log(`hello: ${msg}`);
});

socket.emit("test", "Hello from client");

socket.emit("hello", "Hello world client");

socket.on("disconnected", (msg) => {
    console.log(`Client disconnected: ${msg}`);
});
