let {dmTopLevelContainer} = require('./modular-dm');

let test = new dmTopLevelContainer('../controls');

// test.on('testRouter1', control => {
//     control.input1.on('vu', data => {
//         console.log(data);
//     })
// })

test.Set({
    testRouter1: {
        controlType: 'Router',
        input1: {
            controlType: 'AudioInput',
            source: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
            vuInterval: 100,
        },

        output1: {
            controlType: 'AudioOutput',
            sink: 'alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
        },

        opusOut1: {
            controlType: 'OpusOutput',
        },

        // opusIn1: {
        //     controlType: 'OpusInput',
        // },

        loopback1: {
            controlType: 'AudioLoopback',
            source: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
            sink: 'opusOut1',
        },

        // loopback2: {
        //     controlType: 'AudioLoopback',
        //     source: 'opusIn1.monitor',
        //     sink: 'alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
        // },
    }
});

setTimeout(() => { test.testRouter1.run = true }, 500)

setTimeout(() => {
    test.testRouter1.opusOut1.run = true;
    // test.testRouter1.opusIn1.run = true;
}, 1000);

setTimeout(() => {
    test.testRouter1.loopback1.run = true;
    // test.testRouter1.loopback2.run = true;
}, 2000);

setTimeout(() => {
    test.testRouter1.opusOut1.run = false;
    // test.testRouter1.opusIn1.run = false;

    test.testRouter1.loopback1.run = false;
    // test.testRouter1.loopback2.run = false;
}, 40000);