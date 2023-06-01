let {dmTopLevelContainer} = require('./modular-dm');

let test = new dmTopLevelContainer('../controls');

console.log(test);

test.Set({
    testRouter1: {
        controlType: 'Router',
        input1: {
            controlType: 'AudioInput',
        }
    }
});

console.log(test);