let {dmTopLevelContainer} = require('./modular-dm');

let test = new dmTopLevelContainer('../controls');

test.on('testRouter1', control => {
    control.on('sources', data => {
        console.log(data);
    })
})

test.Set({
    testRouter1: {
        controlType: 'Router',
        input1: {
            controlType: 'AudioInput',
            source: 'alsa_input.usb-Solid_State_Logic_SSL_2-00.analog-stereo'
        }
    }
});

setTimeout(() => {
    test.testRouter1.run = true;
}, 10000)
