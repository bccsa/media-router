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
const _device = require("./device_modules/_device");

// -------------------------------------
// Global variables
// -------------------------------------

var controls = new _device(); // Top level control for devices

// -------------------------------------
// Startup logic
// -------------------------------------

// Load config file from disk
loadConfig();

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

const managerApp = express();
const managerHttp = require('http').createServer(managerApp);

try {
    managerHttp.listen(8082, () => {
        eventLog('Manager WebApp running on *:8082');
    });
}
catch (err) {
    eventLog(`Unable to start Manager WebApp: ${err.message}`);
}

// Serve html files
managerApp.use(express.static('client'));

// Serve DeviceList generated html (default page);
// deviceListHtml = deviceList.GetHtml();
// clientApp.get('/', (req, res) => {
//     res.send(deviceListHtml);
// });


// -------------------------------------
// Client WebApp Socket.IO
// -------------------------------------

const clientIO = require('socket.io')(clientHttp);

clientIO.on('connection', socket => {
    // Send initial (full) state
    socket.emit('data', controls.GetConfig({client: true, includeRun: true}));

    socket.on('data', data => {
        controls.SetConfig(data);
    });
});

// Forward data to clients
controls.on('data', data => {
    clientIO.emit('data', data);
});

// -------------------------------------
// Manager Socket.IO
// -------------------------------------

// -------------------------------------
// Socket.io authentication
// -------------------------------------

const managerIO = require('socket.io-client')('http://localhost:8083', 
{
    reconnect: true,
    auth: {
        username: "user",
        password: "6q8uGT}x+$cD:YxYJq^Nu-",
    },
});

// log connection error 
managerIO.on("connect_error", (err) => {
    // console.log(err);
})

// -------------------------------------
// Socket.io communication
// -------------------------------------

// -------------------------------------
// Event subscription
// -------------------------------------

// Event log
controls.on('log', message => {
    eventLog(message);
});

// // client UI updates
// deviceList.on('data', data => {
//     Object.keys(data).forEach(deviceName => {
//         clientIO.in(`${deviceName}`).emit('deviceUpdate', data[deviceName]);
//     });
// });

// -------------------------------------
// Configuration management
// -------------------------------------

// Load settings from file
function loadConfig() {
    try {
        eventLog('Loading configuration from config.json');

        var raw = fs.readFileSync('config.json');

        // Parse JSON file
        let config = JSON.parse(raw);

        controls.SetConfig(config);
    }
    catch (err) {
        eventLog('Unable to load config.json from file: ' + err.message);
        // eventLog('Generating a template config file...')

        // var data = JSON.stringify(deviceList.GetConfigTemplate(), null, 2); //pretty print
        // try {
        //     fs.writeFileSync('config.json', data);

        //     // Re-load configuration
        //     loadConfig();
        // }
        // catch (err) {
        //     eventLog('Unable to write config.json to disk: ' + err.message);
        // }
    }
}

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
    if (!_exit) {
        // Stop devicelist on exit
        deviceList._stop();

        // // Delete socket files created for audio mixer
        // let regex = /[.]sock$/;
        // fs.readdirSync('./')
        //     .filter(f => regex.test(f))
        //     .map(f => fs.unlinkSync(f));

        _exit = true;
        process.exit();
    }
    
}

// // Delete socket files created by fluent-ffmpeg-multistream
// deviceList.on('stop', () => {
//     let regex = /[.]sock$/;
//     fs.readdirSync('./')
//         .filter(f => regex.test(f))
//         .map(f => fs.unlinkSync(f));
// });