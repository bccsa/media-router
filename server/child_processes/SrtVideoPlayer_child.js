const { _SrtVideoPlayer } = require('bindings')('../../gst_modules/SrtVideoPlayer/build/Release/gstreamer.node');

const _uri = process.argv[2];
const _sink = process.argv[3];
const _paLatency = process.argv[4];

const p = new _SrtVideoPlayer(_uri, _sink, parseFloat(_paLatency));

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })
}, 1000);
