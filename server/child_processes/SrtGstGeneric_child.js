const { _GstGeneric } = require('bindings')('../../gst_modules/GstGeneric/build/Release/gstreamer.node');

const _pipeline = process.argv[2];

const p = new _GstGeneric(_pipeline);

// local var
let running = false;

const _functions = {
    GetSrtStats: GetSrtStats
}

setTimeout(() => {
    p.Start((message) => {
        console.log(message);
    })

    running = true;
}, 1000);


/**
 * Listen on messages from parent, and process function accordingly
 */
process.on("message", ([action, ...args]) => {
    _functions[action](args); // call action
});


/**
 * Get Srt Stats from gstreamer element
 * @param {String} resMessage - Message name for SrtStats
 * @param {String} srtElementName - Srt Element name
 */
function GetSrtStats ([resMessage, srtElementName]) {
    if (running)
    process.send && process.send([resMessage, p.GetSrtStats(srtElementName)]);
}
