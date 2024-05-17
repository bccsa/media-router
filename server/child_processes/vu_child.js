const { _GstvuMeter } = require('bindings')('../../gst_modules/GstvuMeter/build/Release/gstreamer.node');

const _pipeline = process.argv[2];

const p = new _GstvuMeter(_pipeline);

setTimeout(() => {
    p.Start((data) => {
        process.send && process.send(["vuData", data]);
    })
}, 10);

