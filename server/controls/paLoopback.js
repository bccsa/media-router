let { dm } = require('../modular-dm');

/**
 * PulseAudio Loopback module
 */
class paLoopback extends dm {
    constructor() {
        super();
        this.hideData = true;
    }
}

module.exports = paLoopback;