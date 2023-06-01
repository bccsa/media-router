let { dm } = require('../modular-dm');

/**
 * Router control
 */
class Router extends dm {
    constructor() {
        super();
        this.run = false;
        this.autoStart = false;
        this.username = "";
        this.password = "";
        this.description = "";
    }
}

module.exports = Router;