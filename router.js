// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------
const AudioMixer = require('audio-mixer');
const { HwInput } = require('./class/HwInput');
const { HwOutput } = require('./class/HwOutput');
const { RtpInput } = require('./class/RtpInput');
const { RtpOutput } = require('./class/RtpOutput');
const { SrtRtp } = require('./class/SrtRtp');
const { RtpSrt } = require('./class/RtpSrt');

var hwIn = new HwInput();
hwIn.device = 'S2';
hwIn.log.on('log', data => { console.log(data) });

var hwOut = new HwOutput();
hwOut.device = 'Headphones';
hwOut.log.on('log', data => { console.log(data) });

hwOut.Start();
hwIn.Start();
hwIn.stdout.pipe(hwOut.stdin);

// hwOut.Start();

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
// hw2.Start();
// //hw2.stdout.pipe(rtpOut2.stdin);
// hw2.stdout.pipe(mixIn2);

// // rtpIn2.Start();
// // rtpIn2.stdout.pipe(mixIn2);

// var hwOut = new HwOutput();
// hwOut.Start();
// mixer.pipe(hwOut.stdin);

// // const speaker = new Speaker({
// //    channels: 1,
// //    bitDepth: 16,
// //    sampleRate: 48000
// //  });
// //  mixer.pipe(speaker);


 




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
