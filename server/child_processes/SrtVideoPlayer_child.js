const { _SrtVideoPlayer } = require('bindings')('../../gst_modules/SrtVideoPlayer/build/Release/gstreamer.node');

const _uri = process.argv[2];
const _sink = process.argv[3];
const _paLatency = process.argv[4];
const _display = process.argv[5];
const _fullscreen = process.argv[6];
const _displayName = process.argv[7];

const p = new _SrtVideoPlayer(_uri, _sink, _paLatency, _display, _fullscreen, _displayName);

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })
}, 1000);
