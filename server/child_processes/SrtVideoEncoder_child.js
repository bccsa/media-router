const { _GstGeneric } = require('bindings')('../../gst_modules/GstGeneric/build/Release/gstreamer.node');

const _pipeline = process.argv[2];
const _srtElementName = process.argv[3];

const p = new _GstGeneric(_pipeline);

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })

    // Poll for srt stats
    setInterval(() => {
        process.send && process.send(["SrtStats", p.GetSrtStats(_srtElementName)]);
    }, 2000)
    
}, 1000);
