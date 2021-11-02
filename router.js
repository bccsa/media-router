// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------
var { HwInput } = require('./class/HwInput');
var { HwOutput } = require('./class/HwOutput');
var AudioMixer = require('audio-mixer');

var hw1 = new HwInput();
hw1.hwInput = 'hw:1';

var hw2 = new HwInput();
hw2.hwInput = 'hw:2';

var hwOut = new HwOutput();

// Mixer does not work well with bit depth of more than 16 bit
let mixer = new AudioMixer.Mixer({
   channels: 1,
   bitDepth: 16,
   sampleRate: 44100,
   clearInterval: 250
});

let mixIn1 = new AudioMixer.Input({
   channels: 1,
   bitDepth: 16,
   sampleRate: 44100,
   volume: 100
});

let mixIn2 = new AudioMixer.Input({
   channels: 1,
   bitDepth: 16,
   sampleRate: 44100,
   volume: 100
});

mixer.addInput(mixIn1);
hw1.Start();
hw1.stdout.pipe(mixIn1);

mixer.addInput(mixIn2);
hw2.Start();
hw2.stdout.pipe(mixIn2);

hwOut.Start();
mixer.pipe(hwOut.stdin);
