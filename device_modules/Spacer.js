// ======================================
// Spacer for client UI
// 
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { _device } = require('./_device');

// -------------------------------------
// Class declaration
// -------------------------------------

class Spacer extends _device {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = "New spacer";
        this.displayWidth = "40px";
        this.displayOrder = 0;
        this._clientHtmlFileName = "Spacer.html";
    }
}

// Export class
module.exports.Spacer = Spacer;