const { configManager } = require("./configManager");
const { userManager } = require("./userManager");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const dgramServer = require("./dgram-comms").Server;

process.chdir(__dirname);

// -------------------------------------
// Global variables
// -------------------------------------

/**
 * List of online routers/
 */
var router_sockets = {};

// -------------------------------------
// Configuration management
// -------------------------------------

// load configuration file passed by argument. If not passed, confManager will try to load from config.json, or return a default configuration as the last resort.
var confManager;
if (process.argv.length > 2) {
    // Load config file from disk
    confManager = new configManager(process.argv[2], "defaultManagerConf.json");
} else {
    confManager = new configManager(
        "managerConf.json",
        "defaultManagerConf.json"
    );
}

// Clear initial online status
Object.values(confManager.config).forEach((router) => {
    router.online = false;
});

// -------------------------------------
// User management
// -------------------------------------

// load userManager
var userMan = new userManager();

// Clear initial online status
Object.values(confManager.config).forEach((router) => {
    router.online = false;
});

// -------------------------------------
// Manager web-app
// -------------------------------------

const manager_app = express();
const manager_http = http.createServer(manager_app);

try {
    manager_http.listen(8080, () => {
        console.log("Manager WebApp running on http://*:8080");
    });

    // Serve the default file
    manager_app.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "/../client/manager.html"));
    });

    // Serve all the files
    manager_app.use(express.static(path.join(__dirname, "/../client")));
} catch (err) {
    console.log("Unable to start manager WebApp:" + err.message);
}

// -------------------------------------
// Socket.io communication with manager WebApp
// -------------------------------------

const manager_io = new Server(manager_http);

// Add authentication middleware
manager_io.use((manager_socket, next) => {
    if (
        userMan.authUser(
            manager_socket.handshake.auth.username,
            manager_socket.handshake.auth.password
        )
    ) {
        next();
    } else {
        next(new Error("Invalid username or password"));
    }
});

// Handle manager WebApp connections
manager_io.on("connection", (manager_socket) => {
    let managerName = manager_socket.handshake.auth.username;
    console.log(`manager web client ${managerName} connected`);

    // Send the full configuration data to the newly connected manager WebApp
    manager_socket.emit("data", confManager.config);

    // Data received from manager WebApp
    manager_socket.on("data", (data) => {
        // Forward data to other connected manager WebApp's
        manager_socket.broadcast.emit("data", data);

        // Append received data to the configuration manager
        confManager.append(data);
        confManager.save();

        // Forward data to routers
        Object.keys(data).forEach((routerName) => {
            if (router_sockets[routerName]) {
                router_sockets[routerName].emit("data", data[routerName]);
            }
        });

        // Create a new list of encryption keys, used for router communication
        generateEncryptionKeys();
    });

    // listen on password change requsets
    manager_socket.on("change_password", (data) => {
        if (
            userMan.authUser(
                manager_socket.handshake.auth.username,
                data.currentPass
            )
        ) {
            userMan.updateUser(
                manager_socket.handshake.auth.username,
                data.newPass
            );
            manager_socket.emit("new_password", true);
        } else {
            manager_socket.emit("new_password", false);
        }
    });

    // Emit build number to manager
    let bn = "DEV";
    try {
        bn = fs
            .readFileSync(path.join(__dirname, "../build-number.txt"), "utf8")
            .toString()
            .replace(/\r?\n|\r/g, "");
    } catch (err) {
        bn = "DEV";
    }

    manager_socket.emit("build_number", bn);
});

// -------------------------------------
// Socket.io communication with router
// -------------------------------------

let encryptionKeys = {};

function generateEncryptionKeys() {
    // Generate encryption keys
    encryptionKeys = {};
    Object.values(confManager.config).forEach((router) => {
        if (router.displayName && router.password) {
            encryptionKeys[router.displayName] = router.password;
        }
    });
}

generateEncryptionKeys();

// const router_io = new Server();
const router_io = new dgramServer({
    port: 3000,
    enforceEncryption: true,
    encryptionKeys,
});

// Handle router connections
router_io.on("connected", (socket) => {
    let routerName = socket.clientID;
    let routerPass = socket.encryptionKey;
    console.log(`router ${routerName} connected`);

    // Get router ID
    // Identify router by router name - add this to the socket's data object (socket.data.routerID)
    let routerConf = Object.values(confManager.config).find(
        (v) => v.displayName == routerName && v.password == routerPass
    );
    if (routerConf && routerConf.name) {
        socket.data || (socket.data = {});
        socket.data.routerID = routerConf.name;
    } else {
        return;
    }

    // Map router id's to sockets
    router_sockets[routerConf.name] = socket;

    // Clear reset and restart commands. These commands may become "sticky" and cause the router to reset / restart directly after connection.
    delete confManager.config[socket.data.routerID].resetCmd;
    delete confManager.config[socket.data.routerID].restartCmd;

    // Send full router configuration to the router on connection
    socket.emit("data", confManager.config[socket.data.routerID], {
        guaranteeDelivery: true,
    });

    // Set online status
    routerConf.online = true;
    manager_io.emit("data", { [socket.data.routerID]: { online: true } });

    // Data received from router
    socket.on("data", (data) => {
        // Forward data to manager client UI
        manager_io.emit("data", { [socket.data.routerID]: data });

        confManager.append({ [socket.data.routerID]: data });
    });

    socket.on("disconnected", (data) => {
        // force disconnect socket
        delete socket;

        // check that router has not connected on a different socket
        if (
            Object.values(router_io.sockets).find(
                (s) => s.data.routerID === socket.data.routerID
            )
        ) {
            return; // early return if router connected on a new socket
        }

        // Remove socket from routers sockets list
        delete router_sockets[socket.data.routerID];

        // Set offline status
        routerConf.online = false;
        manager_io.emit("data", { [socket.data.routerID]: { online: false } });
    });
});
