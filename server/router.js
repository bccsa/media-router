// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const express = require('express');
const path = require('path');
let { dmTopLevelContainer } = require('./modular-dm');
const process = require('process')
const io = require('socket.io-client');
const { configManager } = require('./configManager');

// Set path to runtime directory
process.chdir(__dirname);

// -------------------------------------
// Configuration management
// -------------------------------------
let profileConf;
// Get config file path from passed argument
if (process.argv.length > 2) {
    // Load config file from disk
    profileConf = new configManager(process.argv[2], 'defaultProfileConf.json');
} else {
    profileConf = new configManager('profileConf.json', 'defaultProfileConf.json');
}

function setProfileDetails(property, value) {
    // Listen for connection details updates, and update the local profile manager
    let p = Object.values(profileConf.config).find(p => p.selected);
    if (p) {
        p[property] = value;
        profileConf.save();
    }
}
// -------------------------------------
// Manager socket.io connection
// -------------------------------------
var manager_io;

let reconnectTimer;
/**
 * Connect to the manager's socket.io server
 * @param {string} url 
 */
function manager_connect(url, username, password) {
    // Cancel reconnect timer if existing before (re)connecting.
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }

    // Clear existing connection
    if (manager_io) {
        manager_io.disconnect();
    }

    manager_io = io(url, { auth: { username: username, password: password } });

    manager_io.on('connect', () => {
        console.log('Connected to manager.')
        // Send PulseAudio sources and sinks to manager
        controls.router.NotifyProperty('sources');
        controls.router.NotifyProperty('sinks');
    });

    manager_io.on('connect_error', err => {
        console.log('Unable to connect to manager: ' + err.message);
        // Retry login after 10 seconds
        reconnectTimer = setTimeout(() => {
            manager_connect(url, username, password);
        }, 10000);
    });

    // set data from manager to router controls
    manager_io.on('data', data => {
        controls.router.Set(data);
        clientIO.emit('data', data);
    });
}

// -------------------------------------
// Startup logic
// -------------------------------------
var controls = new dmTopLevelContainer('../controls');

let cString; // previous connection details

/**
 * Create / re-create a new Router instance
 */
function loadRouter() {
    let s = Object.values(profileConf.config).filter(t => t.selected);
    
    // Ignore if more than one profile is selected
    if (s.length == 1) {
        let p = s[0];
        if (p && p.url + p.username + p.password != cString) {
            cString = p.url + p.username + p.password;
    
            // Remove the current router configuration
            if (controls.router) {
                controls.router.Set({ remove: true });
            }
    
            // Create a new router
            controls.Set({ router: { controlType: 'Router' } });
        }
    }    
}

controls.on('router', router => {
    // Load the selected profile from the local profile manager
    let c = Object.values(profileConf.config).find(t => t.selected);
    if (c) {
        manager_connect(c.managerUrl, c.username, c.password);
    }

    // forward data from router controls to manager
    router.on('data', data => {
        if (manager_io) {
            manager_io.emit('data', data);
        }
    });

    // Update profile details if changed on manager
    router.on('displayName', displayName => {
        setProfileDetails('username', displayName);
        loadRouter();
    });
    router.on('password', password => {
        setProfileDetails('password', password);
        loadRouter();
    });
}, { immediate: true });

loadRouter();

// -------------------------------------
// Client WebApp Express webserver
// -------------------------------------

const clientApp = express();
const clientHttp = require('http').createServer(clientApp);

try {
    // Serve the default file
    clientApp.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '/../local-client/index.html'));
    });

    // Serve all the files
    clientApp.use(express.static(path.join(__dirname, '/../local-client')));

    clientHttp.listen(8081, () => {
        eventLog('Client WebApp running on *:8081');
    });
}
catch (err) {
    eventLog(`Unable to start Client WebApp: ${err.message}`);
}

// -------------------------------------
// Client WebApp Socket.IO
// -------------------------------------

const clientIO = require('socket.io')(clientHttp);

controls.on('router', router => {
    clientIO.on('connection', socket => {
        // Send initial (full) state
        socket.emit('data', controls.router.Get({ sparse: false }));
    
        socket.on('data', data => {
            // Send data to router
            if (controls.router) {
                controls.router.Set(data);
            }
    
            // Send data to other clients
            socket.broadcast.emit('data', data);
    
            // Send data to manager
            if (manager_io) {
                manager_io.emit('data', data);
            }
        });
    });
    
    // Forward data from router to local clients
    router.on('data', data => {
        clientIO.emit('data', data);
    });
}, { immediate: true });


// -------------------------------------
// Profileman WebApp Express webserver
// -------------------------------------

const profilemanApp = express();
const profilemanHttp = require('http').createServer(profilemanApp);

try {
    // Serve the default file
    profilemanApp.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '/../local-profileman/index.html'));
    });

    // Serve all the files
    profilemanApp.use(express.static(path.join(__dirname, '/../local-profileman')));

    profilemanHttp.listen(8082, () => {
        eventLog('Profileman WebApp running on *:8082');
    });
}
catch (err) {
    eventLog(`Unable to start Profileman WebApp: ${err.message}`);
}

// -------------------------------------
// Profileman WebApp Socket.IO
// -------------------------------------

const profilemanIO = require('socket.io')(profilemanHttp);
profilemanIO.on('connection', socket => {
    socket.emit('data', profileConf.config);

    socket.on('data', data => {
        profileConf.append(data);
        profileConf.save();

        // Reload router if needed
        loadRouter();
    });
});

// -------------------------------------
// Event logging
// -------------------------------------

// Event log
// controls.on('log', message => {
//     eventLog(message);
// });

function eventLog(message) {
    console.log(message);
}

// -------------------------------------
// Cleanup
// -------------------------------------

process.on('exit', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

var _exit = false;
function cleanup() {
    if (controls && controls.router) {
        controls.router.runCmd = false;
    }
    
    if (!_exit) {
        setTimeout(() => {
            _exit = true;
            process.exit();
        }, 500);
    }
}