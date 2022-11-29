// var controls = new uiTopLevelContainer('../local-controls', 'controls');

// controls.SetData({
//     vu: {
//         controlType: "VuMeter"
//     }
// })


class test {
    constructor() {
        this.test = 1234;
    }
}
let t = new test();
console.log(t.test);
t['_properties'] = {}
t._properties.test = t.test;
Object.defineProperty(t, "test", {
    get: function() {
        return this._properties.test;
    },
    set: function(val) {
        this._properties.test = val;
        console.log('property value changed')
    }
});

console.log(t.test);