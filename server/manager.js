const { configManager } = require('./configManager');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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
var confManager = new configManager(process.argv[2]);

// -------------------------------------
// Manager web-app
// -------------------------------------

const manager_app = express();
const manager_http = http.createServer(manager_app);

try {
    manager_http.listen(8080, () => {
        console.log('Manager WebApp running on http://*:8080');
    });

    // Serve the default file
    manager_app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '/../client/manager.html'));
    });

    // Serve all the files
    manager_app.use(express.static(path.join(__dirname, '/../client')));

} catch (err) {
    console.log('Unable to start manager WebApp:' + err.message);
}

// -------------------------------------
// Socket.io communication with manager WebApp
// -------------------------------------

const manager_io = new Server(manager_http);

// Add authentication middleware
manager_io.use((manager_socket, next) => {
    if (manager_socket.handshake.auth.username == 'testUser1' && manager_socket.handshake.auth.password == 'testPass') {
        next();
    } else {
        next(new Error('Invalid username or password'));
    }
});

// Handle manager WebApp connections
manager_io.on('connection', manager_socket => {
    let managerName = manager_socket.handshake.auth.username;
    console.log(`manager web client ${managerName} connected`);

    // Send the full configuration data to the newly connected manager WebApp
    manager_socket.emit('data', confManager.config);

    // Data received from manager WebApp
    manager_socket.on('data', data => {
        // Forward data to other connected manager WebApp's
        manager_socket.broadcast.emit('data', data);

        // Append received data to the configuration manager
        confManager.append(data);
        confManager.save();

        // Forward data to routers
        Object.keys(data).forEach(routerName => {
            if (router_sockets[routerName]) {
                router_sockets[routerName].emit('data', data[routerName]);
            }
        });
    });
});

// -------------------------------------
// Socket.io communication with router
// -------------------------------------

const router_io = new Server();
router_io.listen(3000);
console.log('Listening for router connections on http://*:3000');

// Add authentication middleware
router_io.use((socket, next) => {
    if (socket.handshake.auth.username == 'testRouter1' && socket.handshake.auth.password == 'testPass') {
        next();
    } else {
        next(new Error('Invalid username or password'));
    }
});

// Handle router connections
router_io.on('connection', socket => {
    let routerName = socket.handshake.auth.username;
    console.log(`router ${routerName} connected`);

    // Get router ID
    // Identify router by router name - add this to the socket's data object (socket.data.routerID)
    let routerConf = Object.values(confManager.config).find(v => v.displayName == routerName);
    if (routerConf && routerConf.name) {
        socket.data.routerID = routerConf.name;
    } else {
        return;
    }

    // Map router id's to sockets
    router_sockets[routerConf.name] = socket;


    // Send full router configuration to the router on connection
    socket.emit('data', confManager.config[socket.data.routerID]);

    // Data received from router
    socket.on('data', data => {
        // Forward data to manager client UI
        manager_io.emit('data', { [socket.data.routerID]: data });

        // To do: add online status to be emitted to manager UI
    });

    socket.on('disconnect', data => {
        // Remove socket from routers sockets list
        delete router_sockets[socket.data.routerID];

        // To do: emit offline status to manager UI
    });
});