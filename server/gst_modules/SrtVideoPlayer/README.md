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
const { _SrtVideoPlayer } = require('bindings')('build/Release/gstreamer.node');

const example = new _SrtVideoPlayer(
    "srt://srt.invalid:1234",                               // SRT Url
    "alsa_output.platform-bcm2835_audio.analog-stereo",     // Pulse audio sink 
    50,                                                     // Pulse audio latency (ms)
)

// ------------------
// Setters
// ------------------
// Set srt url
example.SetUri("srt://srt.invalid:1233");
// Set pulse sink
example.SetSink("sink");
// Set pulse latency
example.SetPALatency(50);

// ------------------
// Control functions
// ------------------
/**
 * Start SRT Player
 * Callback: 
 * level: Serverity level
 * message: Message
*/
example.Start((level, message) => {
    // your code
})

/**
 * Stop SRT Player
*/
example.Stop();
```
