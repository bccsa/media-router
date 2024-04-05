const { _SrtVideoPlayer } = require('bindings')('../../gst_modules/SrtVideoPlayer/build/Release/gstreamer.node');

const _uri = process.argv[2];
const _sink = process.argv[3];
const _paLatency = process.argv[4];
const _srtLatency = process.argv[5];

const p = new _SrtVideoPlayer(_uri, _sink, parseFloat(_paLatency), parseFloat(_srtLatency));

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })

    // Poll for srt stats
    setInterval(() => {
        process.send && process.send(p.GetSrtStats());
    }, 2000)
    
}, 1000);
