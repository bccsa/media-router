let { dm } = require('../modular-dm');

// -------------------------------------
// Class declaration
// -------------------------------------

class WebRTCPlayer extends dm {
    constructor() {
        super();
        this.url = 'http://localhost:8889/test';
        this.playerName = 'name';
        this.note = '';
        this.flag = "gb";
    }

    Init() {
        // Trigger saving of configuration when player values change
        this.on("url", () => this._parent._setWebRtcClientConfig());
        this.on("playerName", () => this._parent._setWebRtcClientConfig());
        this.on("note", () => this._parent._setWebRtcClientConfig());
        this.on("flag", () => this._parent._setWebRtcClientConfig());
    }

}

// Export class
module.exports = WebRTCPlayer;