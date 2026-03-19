/**
 * Srt statistics module
 */

let { dm } = require("../modular-dm");

class RistStats extends dm {
    constructor() {
        super();
        this.id = 0;
        this.cname = "";
        this.bitrate = 0;
        this.quality = 0;
        this.rtt = 0;
        this.status = "disconnected"; // status: running/ disconnected
        this.timestamp = Date.now();
        this._timestampInterval = undefined;
    }

    Init() {
        // remove links older than 10 seconds
        this._timestampInterval = setInterval(() => {
            const now = new Date();
            const diff = now - this.timestamp;
            // status disconnected after 2 seconds
            if (diff > 2000) {
                this.status = "disconnected";
            }
            if (diff > 10000) {
                this._notify({ remove: true });
                clearInterval(this._timestampInterval);
                this._timestampInterval = undefined;
                this.Set({ remove: true });
            }
        }, 1000);
    }
}

module.exports = RistStats;
