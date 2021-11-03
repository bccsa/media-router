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

var hw1 = new HwInput();
hw1.hwInput = 'hw:0';

var hw2 = new HwInput();
hw2.hwInput = 'pulse';
hw2.inputChannels = 2;
hw2.log.on('log', data => {
   console.log(data);
})

var hwOut = new HwOutput();

var rtpOut1 = new RtpOutput();
rtpOut1.rtpPort = 3000;
var rtpOut2 = new RtpOutput();
rtpOut2.rtpPort = 3002;

var srtOut1 = new RtpSrt();
srtOut1.srtHost = '0.0.0.0';
srtOut1.srtPort = 4000;
srtOut1.rtpPort = 3000;
srtOut1.srtMode = 'listener';
srtOut1.Start();

var srtIn1 = new SrtRtp();
srtIn1.srtHost = '127.0.0.1';
srtIn1.srtPort = 4000;
srtIn1.rtpPort = 3004;
srtIn1.srtMode = 'caller';
srtIn1.Start();

var rtpIn1 = new RtpInput();
rtpIn1.rtpPort = 3004;
var rtpIn2 = new RtpInput();
rtpIn2.rtpPort = 3002;


// Mixer does not work well with bit depth of more than 16 bit
let mixer = new AudioMixer.Mixer({
   channels: 1,
   bitDepth: 16,
   sampleRate: 48000,
   clearInterval: 250
});

let mixIn1 = new AudioMixer.Input({
   channels: 1,
   bitDepth: 16,
   sampleRate: 48000,
   volume: 100
});

let mixIn2 = new AudioMixer.Input({
   channels: 1,
   bitDepth: 16,
   sampleRate: 48000,
   volume: 100
});



mixer.addInput(mixIn1);
mixer.addInput(mixIn2);

hw1.Start();
rtpOut1.Start();
hw1.stdout.pipe(rtpOut1.stdin);

hw2.Start();
rtpOut2.Start();
hw2.stdout.pipe(rtpOut2.stdin);

rtpIn1.Start();
rtpIn1.stdout.pipe(mixIn1);

rtpIn2.Start();
rtpIn2.stdout.pipe(mixIn2);

hwOut.Start();
mixer.pipe(hwOut.stdin);

