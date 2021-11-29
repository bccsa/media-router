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









// var AlsaIn = new AlsaInput();
// AlsaIn.device = 'AudioPCI';
// AlsaIn.log.on('log', data => { console.log(data) });

// var AlsaOut = new AlsaOutput();
// AlsaOut.device = 'AudioPCI';
// AlsaOut.log.on('log', data => { console.log(data) });

// var ffplayOut = new ffplayOutput();
// ffplayOut.log.on('log', data => { console.log(data) });

// //AlsaOut.Start();
// ffplayOut.Start()
// AlsaIn.Start();
// //AlsaIn.stdout.pipe(AlsaOut.stdin);
// AlsaIn.stdout.pipe(ffplayOut.stdin);
// // AlsaOut.Start();

// var rtpOut2 = new RtpOutput();
// rtpOut2.rtpPort = 3002;
// rtpOut2.log.on('log', data => {
//    console.log(data);
// })

// var srtOut2 = new RtpSrt();
// srtOut2.srtHost = '';
// srtOut2.srtPort = 4002;
// srtOut2.rtpPort = 3002;
// srtOut2.srtMode = 'listener';
// srtOut2.srtLatency = 1;
// srtOut2.log.on('log', data => {
//    console.log(data);
// })
// srtOut2.Start();


// var srtIn2 = new SrtRtp();
// srtIn2.srtHost = '127.0.0.1';
// srtIn2.srtPort = 4002;
// srtIn2.rtpPort = 3004;
// srtIn2.srtMode = 'caller';
// srtIn2.srtLatency = 1;
// srtIn2.log.on('log', data => {
//    console.log(data);
// })
// srtIn2.Start();

// var rtpIn2 = new RtpInput();
// rtpIn2.rtpPort = 3004;
// rtpIn2.log.on('log', data => {
//    console.log(data);
// })


// // Mixer does not work well with bit depth of more than 16 bit
// let mixer = new AudioMixer.Mixer({
//    channels: 1,
//    bitDepth: 16,
//    sampleRate: 48000,
//    clearInterval: 250
// });


// let mixIn2 = new AudioMixer.Input({
//    channels: 1,
//    bitDepth: 16,
//    sampleRate: 48000,
//    volume: 100
// });

// mixer.addInput(mixIn2);


// rtpOut2.Start();
// Alsa2.Start();
// //Alsa2.stdout.pipe(rtpOut2.stdin);
// Alsa2.stdout.pipe(mixIn2);

// // rtpIn2.Start();
// // rtpIn2.stdout.pipe(mixIn2);

// var AlsaOut = new AlsaOutput();
// AlsaOut.Start();
// mixer.pipe(AlsaOut.stdin);

// // const speaker = new Speaker({
// //    channels: 1,
// //    bitDepth: 16,
// //    sampleRate: 48000
// //  });
// //  mixer.pipe(speaker);


 

// // Load settings from file
// function loadConfig() {
//     try {
//         var raw = fs.readFileSync('config.json');

//         // Parse JSON file
//         config = JSON.parse(raw);

//         // Template client data for comparison
//         var template = clientTemplate();

//         // Loop through clientData array
//         Object.keys(clientData).forEach(key => {
//             // Create blank clientStatus objects for all array entries
//             clientStatus[key] = newClientStatus();

//             // Upgrade helper: Compare loaded object with template object, and add missing values to loaded object
//             Object.keys(template.settings).forEach(k => {
//                 if (clientData[key].settings[k] == undefined) {
//                     clientData[key].settings[k] = template.settings[k];
//                 }
//             });
//         });

//     } catch (err) {
//         console.log('Unable to load clientData.json from file: ' + err.message);

//         // Add a new client
//         newClient();
//     }
// }

// // Save settings to file
// function saveSettings() {
//     var data = JSON.stringify(clientData, null, 2); //pretty print
//     try {
//         fs.writeFileSync('clientData.json', data);
//     } catch (err) {
//         console.log('Unable to write clientData.json to disk: ' + err.message);
//     }
// }


// #################################
// Mixer
// #################################

// Mixer does not work well with bit depth of more than 16 bit
// let mixer = new AudioMixer.Mixer({
//   channels: 2,
//   bitDepth: 32,
//   sampleRate: 44100,
//   clearInterval: 250
// });


// let mixIn1 = new AudioMixer.Input({
//   channels: 2,
//   bitDepth: 32,
//   sampleRate: 44100,
//   volume: 100
// });

// mixer.addInput(mixIn1);
