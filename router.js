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
const { DeviceList } = require("./class/DeviceList");

// -------------------------------------
// Global variables
// -------------------------------------

var deviceList = new DeviceList();

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
clientApp.use("/", express.static(path.join(__dirname, "/html")));

// Serve DeviceList generated html (default page);
deviceListHtml = deviceList.GetHtml();
clientApp.get('/', (req, res) => {
    res.send(deviceListHtml);
});

// -------------------------------------
// Client WebApp Socket.IO
// -------------------------------------

const clientIO = require('socket.io')(clientHttp);

clientIO.on('connection', socket => {
    // Device status request from client
    socket.on('req_deviceStatus', DeviceName => {
        // Join client to Device room
        socket.join(`${DeviceName}`);
        // emit device status
        socket.emit('deviceStatus', deviceList.GetClientUIstatus(DeviceName));
    });

    // Command from client UI
    socket.on('set_deviceCommand', clientData => {
        if (clientData.deviceName != undefined) {
            deviceList.SetClientUIcommand(clientData);
        }
    });
});

// -------------------------------------
// Event subscription
// -------------------------------------

// Event log
deviceList.log.on('log', message => {
    eventLog(message);
});

// client UI updates
deviceList.clientUIupdate.on('data', data => {
    Object.keys(data).forEach(deviceName => {
        clientIO.in(`${deviceName}`).emit('deviceUpdate', data[deviceName]);
    });
});

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

        deviceList.SetConfig(config);
    }
    catch (err) {
        eventLog('Unable to load config.json from file: ' + err.message);
        eventLog('Generating a template config file...')

        var data = JSON.stringify(deviceList.GetConfigTemplate(), null, 2); //pretty print
        try {
            fs.writeFileSync('config.json', data);

            // Re-load configuration
            loadConfig();
        }
        catch (err) {
            eventLog('Unable to write config.json to disk: ' + err.message);
        }
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
        deviceList.Stop();

        // Delete socket files created for audio mixer
        let regex = /[.]sock$/;
        fs.readdirSync('./')
            .filter(f => regex.test(f))
            .map(f => fs.unlinkSync(f));

        _exit = true;
        process.exit();
    }
    
}

// // Delete socket files created by fluent-ffmpeg-multistream
// deviceList.run.on('stop', () => {
//     let regex = /[.]sock$/;
//     fs.readdirSync('./')
//         .filter(f => regex.test(f))
//         .map(f => fs.unlinkSync(f));
// });