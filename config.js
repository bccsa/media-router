const fs = require('fs');

/**
 * Configuration management
 */
class config {
    /**
     * 
     * @param {string} path - path to the configuration file
     */
    constructor(path) {
        this.path = path;
    }

    /**
     * Loads a configuration file from disk. If the file does not exists, it returns a default configuration.
     */
    loadConfig() {
        try {
            if (!this.path) {
                // Load from default path
                this.path = 'config.json'
            }

            console.log(`Loading configuration from ${this.path}`);

            var raw = fs.readFileSync(this.path);

            // Parse JSON file
            let config = JSON.parse(raw);

            controls.SetConfig(config);
        }
        catch (err) {
            console.log(`Unable to load configuration from file (${this.path}): ${err.message}`);
        }
    }

    /**
     * Save configuration to config.json located in the runtime directory
     * @param {object} config - configuration
     */
    saveConfig(config) {
        try {
            fs.writeFileSync(this.path, JSON.stringify(config, null, 2));
        } catch (err) {
            console.log('Unable to save ' + this.path + ': ' + err.message);
        }
    }
}

module.exports.config = config;