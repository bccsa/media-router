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
let localConf;
// Get config file path from passed argument
if (process.argv.length > 2) {
    // Load config file from disk
    localConf = new configManager(process.argv[2], 'defaultRouterConf.json');
} else {
    localConf = new configManager('localConf.json', 'defaultRouterConf.json');
}



// -------------------------------------
// Manager socket.io connection
// -------------------------------------
var manager_io;

/**
 * Connect to the manager's socket.io server
 * @param {string} url 
 */
function manager_connect(url, username, password) {
    // Clear existing connection
    if (manager_io) {
        manager_io.disconnect();

        // To do: Stop running router
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
controls.Set({ router: { controlType: 'Router' } });
controls.on('router', router => {
    let c = Object.values(localConf.config).find(t => t.selected);
    if (c) {
        manager_connect(c.managerUrl, c.username, c.password);

        // forward data from router controls to manager
        router.on('data', data => {
            if (manager_io) {
                manager_io.emit('data', data);
            }
        });
    }
}, { immediate: true });

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

controls.on('router', router => {
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
    // Send initial (full) state
    // socket.emit('data', controls.router.Get({ sparse: false }));

    // socket.on('data', data => {
    //     // Send data to router
    //     if (controls.router) {
    //         controls.router.Set(data);
    //     }

    //     // Send data to other Profileman
    //     socket.broadcast.emit('data', data);

    //     // Send data to manager
    //     if (manager_io) {
    //         manager_io.emit('data', data);
    //     }
    // });
});

// controls.on('router', router => {
//     // Forward data from router to local profilemans
//     router.on('data', data => {
//         profilemanIO.emit('data', data);
//     });
// }, { immediate: true });


// Serve html files
// clientApp.use("/", express.static(path.join(__dirname, "/html")));
// clientApp.use(express.static('local-client'));

// Serve DeviceList generated html (default page);
// let deviceListHtml = deviceList.GetHtml();
// clientApp.get('/', (req, res) => {
//     res.send(deviceListHtml);
// });


// -------------------------------------
// Manager WebApp Express webserver
// -------------------------------------

// const managerApp = express();
// const managerHttp = require('http').createServer(managerApp);

// try {
//     managerHttp.listen(8082, () => {
//         eventLog('Manager WebApp running on *:8082');
//     });
// }
// catch (err) {
//     eventLog(`Unable to start Manager WebApp: ${err.message}`);
// }

// // Serve html files
// managerApp.use(express.static('client'));

// Serve DeviceList generated html (default page);
// deviceListHtml = deviceList.GetHtml();
// clientApp.get('/', (req, res) => {
//     res.send(deviceListHtml);
// });





// -------------------------------------
// Event subscription
// -------------------------------------

// Event log
// controls.on('log', message => {
//     eventLog(message);
// });

// -------------------------------------
// Configuration management
// -------------------------------------

// Load settings from file
// function loadConfig(path) {
//     try {
//         if (!path) {
//             // Load from default path
//             path = 'config.json'
//         }

//         eventLog(`Loading configuration from ${path}`);

//         var raw = fs.readFileSync(path);

//         // Parse JSON file
//         let config = JSON.parse(raw);

//         controls.Set(config);
//     }
//     catch (err) {
//         eventLog(`Unable to load configuration from file (${path}): ${err.message}`);
//     }
// }

// -------------------------------------
// Client controller
// -------------------------------------
// let schema = [
//     {
//         deviceType: "DeviceList",
//         clientType: "client_DeviceList",
//         managerType: ""
//     },
//     {
//         deviceType: "AudioInput",
//         clientType: "client_AudioInputDevice",
//         managerType: ""
//     },
//     {
//         deviceType: "SrtOpusInput",
//         clientType: "client_AudioInputDevice",
//         managerType: ""
//     },
// ];



// -------------------------------------
// Event logging
// -------------------------------------

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
    router.run = false;
    if (!_exit) {
        router.run = false;

        setTimeout(() => {
            _exit = true;
            process.exit();
        }, 500);
    }
}

// // Delete socket files created by fluent-ffmpeg-multistream
// deviceList.on('stop', () => {
//     let regex = /[.]sock$/;
//     fs.readdirSync('./')
//         .filter(f => regex.test(f))
//         .map(f => fs.unlinkSync(f));
// });