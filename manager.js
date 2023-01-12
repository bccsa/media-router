const {config} = require('./config');

// -------------------------------------
// Global variables
// -------------------------------------
var conf = new config;

// -------------------------------------
// Startup logic
// -------------------------------------

// Get config file path from passed argument
if (process.argv.length > 2) {
    // Load config file from disk
    loadConfig(process.argv[2]);
} else {
    loadConfig('config.json');
}

//================================================================================================================