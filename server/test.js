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
            loopback1: {
                controlType: 'AudioLoopback',
                source: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
                sink: 'alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
            }
        },

        output1: {
            controlType: 'AudioOutput',
            sink: 'alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo',
        }
    }
});

setTimeout(() => { test.testRouter1.run = true }, 500)

setTimeout(() => {
    test.testRouter1.input1.loopback1.run = true;
}, 1000);

setTimeout(() => {
    test.testRouter1.input1.loopback1.run = false;
}, 40000);