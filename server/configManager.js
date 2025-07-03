const fs = require('fs');
const events = require('events');

/**
 * Configuration management
 * @property {string} path - path to the configuration file
 * @property {string} defaultConfig - path to a default configuration file to be loaded if 'path' does not exist or is invalid
 * @property {object} config - Configuration object managed by the configuration manager
 * @property {string} configDirectory - Directory of the configuration file
 */
class configManager extends events {
    /**
     * Configuration management
     * @param {string} path - path to the configuration file
     * @param {string} defaultConfig - optional: path to a default configuration file to be loaded if 'path' does not exist or is invalid
     */
    constructor(path, defaultConfig = undefined) {
        super();
        this.path = path;
        this.defaultConfig = defaultConfig;
        this.config = this._load();
        this.configDirectory = this.path.substring(0, this.path.lastIndexOf('/')) || __dirname;
    }

    /**
     * Loads a configuration file from disk. If the file does not exists, it returns a default configuration.
     */
    _load() {
        try {
            if (!this.path) {
                // Load from default path
                this.path = 'config.json'
            }

            console.log(`Loading configuration from ${this.path}`);

            var raw = fs.readFileSync(this.path);

            // Parse JSON file and return
            return (JSON.parse(raw));
        }
        catch (err) {
            // Return the default configuration file if available
            if (this.defaultConfig) {
                return new configManager(this.defaultConfig)._load();
            } else {
                console.log(`Unable to load configuration from file (${this.path}): ${err.message}`);
                return {};
            }
        }
    }

    /**
     * Save configuration to config.json located in the runtime directory
     */
    save() {
        try {
            fs.writeFileSync(this.path, JSON.stringify(this.config, null, 2));
        } catch (err) {
            console.log('Unable to save ' + this.path + ': ' + err.message);
        }
    }

    /**
     * Append object to the configuration manager config. If a key is named "remove", the parent key/value pair will be removed from the stored config.
     * @param {data} config - configuration to be appended
     */
    append(config) {
        if (typeof config === "object" && config !== null) {
            this._append(config, this.config);
        } else {
            console.log('configManager: Unable to append configuration - invalid object')
        }
    }

    // Append source object data to destination object
    _append(source, destination) {
        Object.keys(source).forEach(key => {
            // Append data to destination.
            let val = source[key];
            if (typeof val === "object" && val !== null && !Array.isArray(source[key])) {
                if (val.remove == true) {
                    // Remove destination child object if the source remove key is set
                    delete destination[key];
                } else {
                    // Create destination child object if it does not exist
                    if (!destination[key]) {
                        destination[key] = {};
                    }

                    // append data to destination child object
                    this._append(val, destination[key]);
                }
            } else {
                var v = val; // Break reference to source object
                destination[key] = v;
                // emit updated value
                this.emit(key, v);
            }
        });
    }
}

module.exports.configManager = configManager;