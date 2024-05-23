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
const { _GstGeneric } = require('bindings')('build/Release/gstreamer.node');

const example = new _GstGeneric(    // gstreamer pipeline
    `v4l2src device=/dev/video0 do-timestamp=true ! video/x-raw,format=YUY2,colorimetry=bt709,pixel-aspect-ratio=1/1,interlace-mode=progressive ! videoconvert ! videorate ! video/x-raw,framerate=25/1 ! videoscale ! video/x-raw,width=1280,height=720 ! \
    openh264enc name=openh264enc multi-thread=4 bitrate=8000000 min-force-key-unit-interval=1000 rate-control=off slice-mode=5 ! \
    video/x-h264,profile=baseline ! mux. pulsesrc device="alsa_input.usb-0b0e_Jabra_SPEAK_510_USB_1C48F9F6B5B3020A00-00.mono-fallback" ! queue leaky=2 max-size-time=1000 ! audioconvert ! audioresample ! voaacenc ! aacparse ! \
    mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=1000 ! srtserversink name=srtserversink sync=false uri="srt://0.0.0.0:1234?latency=1&mode=listener"`
)

// ------------------
// Setters
// ------------------
// Set srt Pipeline
example.SetPipeline("New pipeline");   
// Set (Generic setter)
/**
 * elementName - name of elemnet, specified in the pipeline with name=<name>
 * valType - Type of value to set (gdouble, int, string, bool)
 * key - key to update
 * value - Integer value to update (atm it only work with intager)
*/
example.Set("elementName", "gdouble", "key", Intvalue);

// ------------------
// Getters
// ------------------

/**
 * elementName - name of srt elemnet, specified in the pipeline with name=<name>
 * 
 * return and object with srt stats
*/
console.log(example.GetSrtStats("elementName"));

// ------------------
// Control functions
// ------------------
/**
 * Start SRT Player
 * Callback: 
 * message: Message
*/
example.Start((message) => {
    // your code
})

/**
 * Stop SRT Player
*/
example.Stop();

```
### Example (Used for vu meter data)

```js
// ------------------
// Using gstGeneric for VUdata
// prerequisite (event emmiter, level element in pipeline)
// ------------------
const event = require("events");
const emitter = new event.EventEmitter();

const example2 = new _GstGeneric(    // gstreamer pipeline
    `pulsesrc device=MR_PA_SoundProcessor_4157_sink.monitor ! audio/x-raw,rate=48000,format=S16LE,channels=2 ! level ! fakesink`,
    emitter.emit.bind(emitter)
)

example2.Start(msg => {
    console.log(msg);
})

// Listen on vuData to get an object with the following data: rms, peak and decay for all available channels
emitter.on("vuData", data => {
    console.log(data);
})
```
