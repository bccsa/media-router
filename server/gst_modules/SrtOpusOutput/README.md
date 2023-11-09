# Gstreamer C++ modal 

## Links
* Initial Tutorial: https://dev.to/ethand91/gstreamer-tutorial-part-1-as-a-node-native-addon-25j8
* node-addon-api Tutorial: https://medium.com/@a7ul/debugging-nodejs-c-addons-using-vs-code-27e9940fc3ad
* https://stackoverflow.com/questions/39367246/select-certain-monitor-for-going-fullscreen-with-gtk
* https://blog.degitx.com/general/gstreamer-h264-capture.html
* https://gitlab.ifi.uzh.ch/scheid/bcoln/-/blob/619c184df737026b2c7ae222d76da7435f101d9a/Web3/web3js/node_modules/node-addon-api/doc/object_wrap.md
* Callbacks: https://stackoverflow.com/questions/55637772/streaming-data-into-a-node-js-c-addon-with-n-api

## Prerequisites 
* gstreamer
* bindings ```npm i bindings```
* node-addon-api ```npm i node-addon-api```

## Build 
* run ```npm i``` to create a new build of the c++ 

## DEBUG c++ addons 

### Prerequisites
* *Need to cd into server/gst_module/SrtVideoInput*
#### Build dependencies
* node-gyp ```sudo npm -g install node-gyp```
* node-addon-api ```npm install node-addon-api```
* bindings ```npm install bindings```
* gstreamer

##### Configure build
* run ```node-gyp configure```
* run ```npm i```

#### Runtime dependencies
* node-addon-api ```npm install node-addon-api```
* bindings ```npm install bindings```
* gstreamer 

#### Dev dependencies
* vscode: https://github.com/vadimcn/vscode-lldb (Used for debugging C++)

### Run in debug mode
* *Need to cd into server/gst_module*
* ```npm run build:gst:dev```

### Build for production
* *Need to cd into server/gst_module*
* ```npm run build:gst```

### Example
```js

// ------------------
// Initialization
// ------------------
const { _SrtOpusOutput } = require('bindings')('build/Release/gstreamer.node');

 * [0] - _device - Pulse audio device - default: null
 * [1] - _paLatency - Palse audio latency (ms) - default: 50
 * [2] - _sampleRate - Sample rate - default: 48000
 * [3] - _bitDepth - default: 16
 * [4] - _channels - Channel amount - default: 2
 * [5] - _bitrate - stream bitrate - default: 64000
 * [6] - _uri - Srt url - default: null
const example = new _SrtOpusOutput(
    "alsa_output.platform-bcm2835_audio.analog-stereo",         //  * [0] - _device - Pulse audio device - default: null
    50,                                                         //  * [1] - _paLatency - Palse audio latency (ms) - default: 50
    48000,                                                      //  * [2] - _sampleRate - Sample rate - default: 48000
    16,                                                         //  * [3] - _bitDepth - default: 16
    2,                                                          //  * [4] - _channels - Channel amount - default: 2
    64000,                                                      //  * [5] - _bitrate - stream bitrate - default: 64000
    "srt://srt.invalid:1234?latency=10&mode=caller"             //  * [6] - _uri - Srt url - default: null
)

// ------------------
// Setters
// ------------------
// Set pipline pulse source
example._device("source");
// Set pulse latency
example._paLatency(50);
// Set sample rate
example._sampleRate(48000);
// Set bit depth
example._bitDepth(16);
// Set channle count
example._channels(1);
// Set bitrate
example._bitrate(64000);
// Set srt url
example._uri("srt://srt.invalid:1233?mode=listener");

// ------------------
// Control functions
// ------------------
/**
 * Start SRT pipline
 * Callback: 
 * level: Serverity level
 * message: Message
*/
example.Start((level, message) => {
    // your code
})

/**
 * Stop SRT pipline
*/
example.Stop();
```
