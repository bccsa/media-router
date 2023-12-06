const { _SrtOpusInput } = require('bindings')('../../gst_modules/SrtOpusInput/build/Release/gstreamer.node');

const _uri = process.argv[2];
const _paLatency = process.argv[3];
const _sink = process.argv[4];

const p = new _SrtOpusInput(_uri, parseFloat(_paLatency), _sink);

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })
}, 1000);
