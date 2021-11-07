// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const fs = require('fs');
//const AudioMixer = require('audio-mixer');
const { AlsaInput } = require('./class/AlsaInput');
const { AlsaOutput } = require('./class/AlsaOutput');
const { ffmpegInput } = require('./class/ffmpegInput');
const { ffplayOutput } = require('./class/ffplayOutput');
const { RtpInput } = require('./class/RtpInput');
const { RtpOutput } = require('./class/RtpOutput');
const { SrtInput } = require('./class/SrtInput');
const { SrtOutput } = require('./class/SrtOutput');

// -------------------------------------
// Global variables
// -------------------------------------

var devices = {};

// -------------------------------------
// Dynamic class creation functions
// -------------------------------------

// Dynamic class map
const classes = {
    AlsaInput,
    AlsaOutput,
    ffmpegInput,
    ffplayOutput,
    RtpInput,
    RtpOutput,
    SrtInput,
    SrtOutput,
}

function dynamicClass(className) {
    return classes[className];
}

// -------------------------------------
// Startup logic
// -------------------------------------

// Load config file from disk
loadConfig();

// -------------------------------------
// Configuration management
// -------------------------------------

// Create default (template) configuration
function defaultConfig() {
    var conf = {};

    Object.keys(classes).forEach(className => {
        // Get class
        let dClass = dynamicClass(className);

        // Create class instance
        let c = new dClass();

        // Get default configuration, and add to config object
        conf[className] = [ c.GetConfig() ];
    });
    
    return conf;
}

// Load settings from file
function loadConfig() {
    try {
        var raw = fs.readFileSync('config.json');

        // Parse JSON file
        let config = JSON.parse(raw);

        // Loop through class names and create class instances with
        // configuration from config file
        Object.keys(config).forEach(className => {
            // Create array for class instances
            if (devices[className] ==  undefined) { devices[className] = [] }

            // Get class
            let dClass = dynamicClass(className);

            // Create class instances
            config[className].forEach(settings => {
                let c = new dClass();
                c.SetConfig(settings);

                // Subscribe to log event
                c.log.on('log', message => {
                    eventLog(message);
                });

                // Start the device
                if (c.Start != undefined) {
                    c.Start();
                }

                // Add to devices list
                devices[className].push(c);
            });
        });
    }
    catch (err) {
        console.log('Unable to load config.json from file: ' + err.message);
        console.log('Generating a template config file...')

        var data = JSON.stringify(defaultConfig(), null, 2); //pretty print
        try {
            fs.writeFileSync('config.json', data);

            // Re-load configuration
            loadConfig();
        }
        catch (err) {
            console.log('Unable to write config.json to disk: ' + err.message);
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
