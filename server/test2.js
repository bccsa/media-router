let { dmTopLevelContainer } = require('./modular-dm');

let test = new dmTopLevelContainer('../controls');

// test.on('testRouter1', control => {
//     control.input1.on('vu', data => {
//         console.log(data);
//     })
// })

test.Set({
    testRouter1: {
        controlType: 'Router',
        autoStart: true,
        input1: {
            controlType: 'AudioInput',
            source: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
            destinations: [
                'opusOut1'
            ],
        },

        output1: {
            controlType: 'AudioOutput',
            sink: 'alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
            channels: 2,
        },

        opusOut1: {
            controlType: 'SrtOpusOutput',
            channels: 2,
            srtHost: '127.0.0.1',
            srtPort: 1234,
            srtMode: 'listener',
            srtLatency: 10,
            udpBufferSize: 2048,
        },

        opusIn1: {
            controlType: 'SrtOpusInput',
            channels: 2,
            srtHost: '127.0.0.1',
            srtMode: 'caller',
            srtLatency: 10,
            udpBufferSize: 2048,
            destinations: [
                'output1'
            ],
        },
    }
});

// setTimeout(() => { test.testRouter1.run = true }, 500)
test.once('testRouter1', val => {
    console.log('testRouter1 test');
})
setTimeout(() => {
    // test.testRouter1.loopback1.run = true;
}, 1000);

setTimeout(() => {
    // test.testRouter1.loopback1.run = true;
    // test.testRouter1.loopback2.run = true;
}, 2000);

setTimeout(() => {
    test.testRouter1.run = false;
    // test.testRouter1.opusIn1.run = false;

    // test.testRouter1.loopback1.run = false;
    // test.testRouter1.loopback2.run = false;
}, 20000);


// process.on('exit', cleanup);
// process.on('SIGINT', cleanup);
// process.on('SIGTERM', cleanup);

// var _exit = false;
// function cleanup() {
//     if (!_exit) {
//         // Stop devicelist on exit
//         test.testRouter1.opusIn1.run = false;
//         setTimeout(() => {
//             _exit = true;
//             process.exit();
//         }, 1000);
//     }
// }