let { dm } = require('../modular-dm');

// -------------------------------------
// Class declaration
// -------------------------------------

class WebRTCPlayer extends dm {
    constructor() {
        super();
        this.url = 'http://localhost:8889/test';
        this.playerName = 'name';
        this.img = "";
    }

    Init() {

    }

}

// Export class
module.exports = WebRTCPlayer;