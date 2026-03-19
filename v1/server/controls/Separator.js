let { dm } = require('../modular-dm');

// -------------------------------------
// Class declaration
// -------------------------------------

class Separator extends dm {
    constructor() {
        super();
        // this.displayWidth = "40px";
        this.displayName = "";  // Display name
        this.displayOrder = 0;
        this.showControl = true;        // show control on local client
    }
}

// Export class
module.exports = Separator;