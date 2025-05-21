let { dm } = require("../modular-dm");

// -------------------------------------
// Class declaration
// -------------------------------------

class RISTConfig extends dm {
    constructor() {
        super();
        this.host = "";
        this.port = 1234;
        this.mode = "caller";
        this.cname = "";
        this.buffer = 50;
        this.weight = 0;
    }

    Init() {}
}

// Export class
module.exports = RISTConfig;
