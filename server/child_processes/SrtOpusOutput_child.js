const { _SrtOpusOutput } = require('bindings')('../../gst_modules/SrtOpusOutput/build/Release/gstreamer.node');

const _source = process.argv[2];
const _paLatency = process.argv[3];
const _sampleRate = process.argv[4];
const _bitDepth = process.argv[5];
const _channels = process.argv[6];
const _bitrate = process.argv[7];
const _uri = process.argv[8];

const p = new _SrtOpusOutput(_source, parseFloat(_paLatency), _sampleRate, _bitDepth, _channels, parseFloat(_bitrate), _uri);

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })

    // Poll for srt stats
    setInterval(() => {
        process.send && process.send(p.GetSrtStats());
    }, 2000)

}, 1000);
