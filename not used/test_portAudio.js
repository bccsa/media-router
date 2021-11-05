// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------
// const AudioMixer = require('audio-mixer');
// const Speaker = require('speaker');
// const { HwInput } = require('./class/HwInput');
// const { HwOutput } = require('./class/HwOutput');
// const { RtpInput } = require('./class/RtpInput');
// const { RtpOutput } = require('./class/RtpOutput');
// const { SrtRtp } = require('./class/SrtRtp');
// const { RtpSrt } = require('./class/RtpSrt');

// var hw2 = new HwInput();
// hw2.hwInput = 'hw:CARD=S2,DEV=0';
// hw2.inputChannels = 2;
// hw2.log.on('log', data => {
//    console.log(data);
// })

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

const portAudio = require('node-portaudio');
const AudioMixer = require('audio-mixer');

// #################################
// Record
// #################################

//const fs = require('fs');
// Create an instance of AudioInput, which is a ReadableStream
const ai = new portAudio.AudioInput({
  channelCount: 2,
  sampleFormat: portAudio.SampleFormat32Bit,
  sampleRate: 44100,
  deviceId : -1, // Use -1 or omit the deviceId to select the default device
  // closeOnError: false,
  // framesPerBuffer: 1024,
  // numBuffers: 10000,
});
 
// handle errors from the AudioInput
ai.on('error', err => {
  console.log(err);
});
 
// Create a write stream to write out to a raw audio file
//const ws = fs.createWriteStream('rawAudio.raw');
 


// #################################
// Play
// #################################

// try {
  // Create an instance of AudioOutput, which is a WriteableStream
  const ao = new portAudio.AudioOutput({
    channelCount: 2,
    sampleFormat: portAudio.SampleFormat32Bit,
    sampleRate: 44100,
    deviceId : -1, // Use -1 or omit the deviceId to select the default device
    // closeOnError: false,
    // framesPerBuffer: 1024,
    // numBuffers: 10000,
  });
  
  // handle errors from the AudioOutput
  ao.on('error', err => {
    console.log(err);
  });
  
  // Create a stream to pipe into the AudioOutput
  // Note that this does not strip the WAV header so a click will be heard at the beginning
  //const rs = fs.createReadStream('steam_48000.wav');
  
  // setup to close the output stream at the end of the read stream
  //rs.on('end', () => ao.end());
  
  // Start piping data and start streaming
  //rs.pipe(ao);


  // #################################
  // Mixer
  // #################################

  // Mixer does not work well with bit depth of more than 16 bit
  let mixer = new AudioMixer.Mixer({
    channels: 2,
    bitDepth: 32,
    sampleRate: 44100,
    clearInterval: 250
  });


  let mixIn1 = new AudioMixer.Input({
    channels: 2,
    bitDepth: 32,
    sampleRate: 44100,
    volume: 100
  });

  mixer.addInput(mixIn1);


  //Start streaming

  // ai.on('data', data => {
  //    console.log(data);
  //    //ao.write(data);
  // });
  ai.pipe(ao);
  //mixer.pipe(ao);
  ai.start();

  ao.start();

  ai.on('close', () => {
    console.log('ai close');
    ai.start();
  })

  ai.on('end', () =>{
    console.log('ai end');
    ai.start();
  })

  ai.on('error', () =>{
    console.log('ai error');
    ai.start();
  })

  ao.on('close', () => {
    console.log('ao close');
    ao.start();
  })

  ao.on('end', () =>{
    console.log('ao end');
    ao.start();
  })

  ao.on('error', () =>{
    console.log('ao error');
    ao.start();
  })
// }
// catch (err) {
//   console.log(err.message);
// }

// save game data on gracefull shutdown
process.on('exit', exitServer);
process.on('SIGINT', exitServer);
process.on('SIGTERM', exitServer);
process.on('SEGFAULT', exitServer);

var exitSaved = false;
function exitServer() {
    // exit process
    console.log('exit');
    process.exit();
}