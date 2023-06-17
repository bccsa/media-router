// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const fs = require('fs');
const express = require('express');
const path = require('path');
let { dmTopLevelContainer } = require('./modular-dm');
const process = require('process')
const io = require('socket.io-client');

// Set path to runtime directory
process.chdir(__dirname);

// -------------------------------------
// Global variables
// -------------------------------------

var controls = new dmTopLevelContainer('../controls');
controls.on('router', router => {
    /**
     * Manager socket.io connection
     */
    var manager_io;

    // -------------------------------------
    // Startup logic
    // -------------------------------------

    manager_connect('http://localhost:3000');

    // Get config file path from passed argument
    // if (process.argv.length > 2) {
    //     // Load config file from disk
    //     loadConfig(process.argv[2]);
    // } else {
    //     loadConfig('config.json');
    // }

    // -------------------------------------
    // Manager socket.io connection
    // -------------------------------------
    var firstCon = true;
    /**
     * Connect to the manager's socket.io server
     * @param {string} url 
     */
    function manager_connect(url) {
        // Clear existing connection
        if (manager_io) {
            manager_io.disconnect();
            firstCon = true;

            // To do: Stop running router
        }

        manager_io = io(url, { auth: { username: 'testRouter1', password: 'testPass' } });

        manager_io.on('connect', () => {
            console.log('Connected to manager.')
            // Send PulseAudio sources and sinks to manager
            router.NotifyProperty('sources');
            router.NotifyProperty('sinks');
        });

        manager_io.on('connect_error', err => {
            console.log('Unable to connect to manager: ' + err.message);
        });

        // set data from manager to router controls
        manager_io.on('data', data => {
            router.Set(data);
        });
    }


    // forward data from router controls to manager
    router.on('data', data => {
        if (manager_io) {
            manager_io.emit('data', data);
        }
    });
});
controls.Set({ router: { controlType: 'Router' } });

// -------------------------------------
// Client WebApp Express webserver
// -------------------------------------

const clientApp = express();
const clientHttp = require('http').createServer(clientApp);

try {
    clientHttp.listen(8081, () => {
        eventLog('Client WebApp running on *:8081');
    });
}
catch (err) {
    eventLog(`Unable to start Client WebApp: ${err.message}`);
}

// Serve html files
// clientApp.use("/", express.static(path.join(__dirname, "/html")));
clientApp.use(express.static('client'));

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
// Client WebApp Socket.IO
// -------------------------------------

// const clientIO = require('socket.io')(clientHttp);

// clientIO.on('connection', socket => {
//     // Send initial (full) state
//     socket.emit('data', controls.Get({client: true, includeRun: true}));

//     socket.on('data', data => {
//         // Send data to router
//         controls.Set(data);

//         // Send data to other clients
//         socket.broadcast.emit('data', data);
//     });
// });

// // Forward data from router to clients
// controls.on('data', data => {
//     clientIO.emit('data', data);
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