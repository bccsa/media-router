const { _GstvuMeter } = require('bindings')('../../gst_modules/GstvuMeter/build/Release/gstreamer.node');

const _pipeline = process.argv[2];
const _callback_name = process.argv[3] || "vuData";

const p = new _GstvuMeter(_pipeline);

setTimeout(() => {
    p.Start((data) => {
        process.send && process.send([_callback_name, data]);
    })
}, 10);

