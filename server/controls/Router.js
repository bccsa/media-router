let { dm } = require('../modular-dm');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const os_utils = require('os-utils');
const os = require('os');

/**
 * Router control
 */
class Router extends dm {
    /**
     * @param {string} path - path to modular-dm control class files. This should be the absolute path to the control files directory or the relative path from the directory where modular-dm is installed.
     */
    constructor(path) {
        super(path);
        this.run = false;                           // External run command
        this.runCmd = false;                        // Internal run command
        this.SetAccess('runCmd', { Set: 'none', Get: 'none' });
        this.displayName = '';                      // Used as router username                 
        this.password = "";
        this._sources = {};
        this._sinks = {};
        this.sources = [];                          // json sources list for front-end
        this.SetAccess('sources', { Set: 'none' }); // Disable Set() access to prevent frontend changing the property
        this.sinks = [];                            // json sinks list for front-end
        this.SetAccess('sinks', { Set: 'none' });   // Disable Set() access to prevent frontend changing the property
        this._udpSocketPortIndex = 2000;
        this.paLatency = 50;                        // PulsAudio modules latency (applied to each dynamically loaded PulseAudio module). Lower latency gives higher PulseAudio CPU usage.
        this._paServerType = '';                    // PulseAudio server type (PipeWire or PulseAudio)
        this.log = [];                              // controls output logs
        this.logINFO = false;                       // log level enabled/ disabled 
        this.logERROR = false;                      // log level enabled/ disabled 
        this.logFATAL = true;                       // log level enabled/ disabled 
        this.restartCmd = false;                    // Router restart command. Router process needs passwordless sudo access to the followng command: "sudo reboot now"
        this.resetCmd = false;                      // Router process reset command. Kills the router.js process. Process should be restarted externally (e.g. via systemd service)
        this.enableDesktop = true;                  // Toggle desktop environment (Enabled/ disabled)
        this._paQueue = [];                         // PulseAudio command rate limiter callback queue
        this._paQueueTimer = undefined;             // Rate limiter timer
        this._paConnectionCount = 0                 // PulseAudio connection counter
        this.startupDelayTime = 3000;               // Startup delay time in milliseconds. This is sometimes needed to give other services (e.g. PulseAudio) sufficient time to start up.
        this.startupState = true;                   // true = Auto (manager selected state); false = Start in stopped state.
        this.cpuUsage = 0;                          // CPU usage indication
        this.ipAddress = "127.0.0.1"                // system IP address    
    }

    Init() {
        super.Init();
        let startupDelay = true;

        //----------------------Get device resources-----------------------------//
        // CPU usage
        setInterval(() => {
            os_utils.cpuUsage((v) => {
                this.cpuUsage = Math.round(v * 100);
            });
        }, 2000)

        // IP address
        setTimeout(() => { this._getIP().then(ip => { this.ipAddress = ip }) }, 5000);
        setInterval(() => { this._getIP().then(ip => { this.ipAddress = ip }) }, 10000)
        //----------------------Get device resources-----------------------------//

        // Relay external run command to child controls
        this.on('run', run => {
            if (!startupDelay) {
                this.runCmd = run;
            }
        });

        // Get the PulseAudio server type
        this._getPAserver()
            .then(serverType => {
                this._paServerType = serverType;
                return this._getPA('');
            }).then(m => {
                // Unload all loopback, nullsink, remap-source and remap-sink modules
                let modules;
                if (this._paServerType == 'PipeWire') {
                    // PipeWire does not keep the PulseAudio driver name (just shows PipeWire), so we need to filter on the name prefix.
                    modules = Object.values(m).filter(t => t.loopback_name && t.loopback_name.indexOf('MR_PA_') >= 0 ||
                        t.source_name && t.source_name.indexOf('MR_PA_') >= 0 ||
                        t.sink_name && t.sink_name.indexOf('MR_PA_') >= 0 ||
                        t.Name && t.Name.indexOf('MR_PA_') >= 0
                    );
                } else {
                    // PulseAudio does not allow storing names on all modules (e.g. module-loopback), so we need to filter on all module types than the Media Router is dynamically adding.
                    modules = Object.values(m).filter(t => t.Driver && (t.Driver.search('module-loopback') >= 0 ||
                        t.Driver.search('module-remap') >= 0 ||
                        t.Driver.search('module-null-sink') >= 0) && t['Owner Module'] && t.Name
                    );
                }

                modules.forEach(paModule => {
                    let cmd = `pactl unload-module ${paModule['Owner Module']}`;
                    exec(cmd, { silent: true }).then(data => {
                        if (data.stderr) {
                            this._log('ERROR', data.stderr.toString());
                        } else {
                            this._log('FATAL', `${this._controlName} (${this.displayName}): Removed ${paModule.Name}`);
                        }
                    }).catch(err => {
                        this._log('FATAL', err.message);
                    });
                });

                // Startup delay after unloading modules
                setTimeout(() => {
                    startupDelay = false;
                    this.runCmd = this.run;
                }, this.startupDelayTime);
            }).catch(err => {
                this._log('FATAL', err.toString());
            });

        // PulseAudio items detection
        this._updatePAlist('sources', this._sources).then(updated => { if (updated) this.sources = Object.values(this._sources) });
        this._updatePAlist('sinks', this._sinks).then(updated => { if (updated) this.sinks = Object.values(this._sinks) });
        let scanTimer = setInterval(async () => {
            this.PaCmdQueue(() => {
                this._updatePAlist('sources', this._sources).then(updated => { if (updated) this.sources = Object.values(this._sources) });
            });
            this.PaCmdQueue(() => {
                this._updatePAlist('sinks', this._sinks).then(updated => { if (updated) this.sinks = Object.values(this._sinks) });
            });
        }, 1000);

        // Stop all child controls when the Router control is removed
        this.on('remove', () => {
            this.runCmd = false;
            clearInterval(scanTimer);
        });

        // Reset command from manager
        this.on('resetCmd', reset => {
            if (reset) {
                this.reset = false;
                this._log('INFO', 'Reset command received. Resetting router process...');
                setTimeout(() => {
                    this._log('ERROR', 'Reset command timeout. Killing router process...');
                    process.kill('SIGKILL');
                }, 5000);

                process.exit();
            }
        });

        // Restart command from manager
        this.on('restartCmd', restart => {
            if (restart) {
                restart = false;
                this._log('INFO', 'Reset command received. Resetting router process...');
                exec('sudo reboot now').catch(err => {
                    this._log('ERROR', 'Unable to reboot router: ' + err.message);
                });
            }
        });

        // Enable/ Disable Desktop 
        this.on('enableDesktop', enable => {
            if (enable) {
                this._log('INFO', 'Enabling desktop environment, please restart');
                exec('sudo systemctl enable lightdm; sudo rm /etc/systemd/system/default.target; sudo systemctl set-default graphical.target').catch(err => {
                    this._log('ERROR', 'Unable to enable desktop environment: ' + err.message);
                });
            } else {
                this._log('INFO', 'Disabling desktop environment, please restart');
                exec('sudo systemctl disable lightdm').catch(err => {
                    this._log('ERROR', 'Unable to disable desktop environment: ' + err.message);
                });
            }
        });
    }

    /**
     * Gets a list of PulseAudio items in json format.
     * @param {string} type - Valid type are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @returns - Promise
     */
    _getPA(type) {
        // code adapted from https://github.com/ctemplin/pactl-lists-json/blob/master/index.js
        function unquote(s) {
            return s.replace(/^[\"\']/, '').replace(/[\"\']$/, '')
        }

        function tokenize(s) {
            function splitLine(l) {
                var hsi = l.indexOf('#')
                var sci = l.indexOf(':')
                var eqi = l.indexOf('=')
                hsi = hsi > -1 ? hsi : Number.MAX_SAFE_INTEGER
                sci = sci > -1 ? sci : Number.MAX_SAFE_INTEGER
                eqi = eqi > -1 ? eqi : Number.MAX_SAFE_INTEGER
                var tokens
                if (hsi < sci) {
                    tokens = l.split('#', 2)
                }
                else if (sci < eqi) {
                    tokens = l.split(':', 2)
                } else {
                    tokens = l.split('=', 2)
                }
                tokens = tokens.map(t => unquote(t.trim()))
                return tokens
            }
            var lineArr = s.split('\n')
            var o = {}
            lineArr = lineArr.map(
                function (l) {
                    var kv = splitLine(l)
                    var key = kv[0]
                    if (key)
                        o[key] = kv[1]
                }
            )
            return o
        }

        function get(type) {
            return new Promise((resolve, reject) => {
                exec('pactl list ' + type, { silent: true }).then(data => {
                    if (data.stderr) reject(stderr);
                    let arr = [];
                    if (data.stdout.length) {
                        var inputBlocks = data.stdout.split('\n\n');
                        inputBlocks.map(function (block) { arr.push(tokenize(block)) });
                    }
                    resolve(arr);
                }).catch(err => {
                    reject(err);
                });
            });
        }

        return get(type);
    }

    /**
     * Update a list of PulseAudio items
     * @param {string} type - Valid types are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @param {object} dst - Destination object to be updated with sources and destinations
     * @returns {boolean} - Returns a promise resolving to true if the destination object (dst) has been updated
     */
    async _updatePAlist(type, dst) {
        return new Promise((resolve, reject) => {
            try {
                this._getPA(type).then(data => {
                    let active = {};
                    let updated = false;

                    // Add new items to dst
                    Object.values(data).forEach(item => {
                        if (item.Name) {
                            // Mark item as active
                            active[item.Name] = true;

                            // Add to dst if not existing
                            if (!dst[item.Name]) {
                                let ch = item['Sample Specification'].match(/[0-9][0-9]*ch/gi);
                                if (ch[0]) ch = parseInt(ch[0].match(/[0-9][0-9]*/gi));

                                let bitDepth = item['Sample Specification'].match(/(float|[sf])\d{1,2}[a-z]{0,2}/gi);
                                if (bitDepth[0]) bitDepth = parseInt(bitDepth[0].match(/[0-9][0-9]*/gi));

                                let sampleRate = item['Sample Specification'].match(/[1-9]\d*Hz/gi);
                                if (sampleRate[0]) sampleRate = parseInt(sampleRate[0].match(/[0-9][0-9]*/gi));

                                // description
                                let description = item.Description;
                                let descIteration = 0;
                                while (Object.values(dst).find(t => t.description == description) != undefined) {
                                    descIteration++;
                                    description = `${item.Description} (${descIteration})`;
                                }

                                if (item.Description && typeof ch === 'number' && ch > 0) {
                                    dst[item.Name] = {
                                        name: item.Name,
                                        description: description,
                                        channels: ch,
                                        bitDepth: bitDepth,
                                        sampleRate: sampleRate,
                                        monitorsource: item['Monitor Source'],
                                        channelmap: item['Channel Map'].split(','),
                                        // mute: item.Mute,
                                    };
                                }

                                updated = true;
                                this._log('INFO', `PulseAudio ${type} detected: ${item.Name}`);
                            }
                        }
                    });

                    // Remove old items from dst
                    Object.keys(dst).forEach(itemName => {
                        if (!active[itemName]) {
                            delete dst[itemName];
                            updated = true;
                            this._log('INFO', `PulseAudio ${type} removed: ${itemName}`);
                        }
                    });

                    resolve(updated);
                }).catch(err => {
                    this._log('FATAL', err.message);
                    resolve(false);
                });
            } catch (err) {
                this._log('FATAL', err.message);
                resolve(false);
            }
        });
    }

    /**
     * Get the PulseAudio server type
     * @returns Promise with the PulseAudio server type (PipeWire or PulseAudio)
     */
    _getPAserver() {
        return new Promise((resolve, reject) => {
            exec('pactl info').then(result => {
                if (result.stdout.indexOf('PipeWire') >= 0) {
                    resolve('PipeWire');
                } else {
                    resolve('PulseAudio');
                }
            }).catch(err => {
                reject('Unable to determine the PulseAudio server type: ' + err.toString());
            });
        });
    }

    /**
     * Get next available UDP socket port
     */
    GetUdpSocketPort() {
        this._udpSocketPortIndex++;
        return this._udpSocketPortIndex;
    }

    /**
     * Controls logger 
     * @param {String} level - log level
     * @param {*} message - log message 
     */
    _log(level, message) {
        let date = new Date().toLocaleString('en-ZA');
        let msg = [level, `${date} | ${level}: \t${message.trim()}`];
        console.log(msg[1]);
        if (this[`log${msg[0]}`])
            this.log = msg;
    }

    /**
     * Rate Limiter for PulseAudio commands. Should be used by all commands interacting with the PulseAudio sound server to prevent overloading the server.
     * @param {*} callback 
     * @returns - Promise resolving when the callback has been run or rejecting if the callback fails
     */
    PaCmdQueue(callback) {
        return new Promise((resolve, reject) => {
            // Add callback to queue
            this._paQueue.push({ callback: callback, resolve: resolve, reject: reject });

            // Start the rate limiter timer if not running
            if (!this._paQueueTimer || this._paQueueTimer._destroyed) {
                this._paCmdQueueNext();
            }
        });
    }

    /**
     * Execute the next callback from the pulseaudio command rate limiter queue
     */
    _paCmdQueueNext() {
        if (this._paQueue.length > 0) {
            let c = this._paQueue.shift();
            try {
                // Execute callback from queue
                c.callback();
                c.resolve();
            } catch (err) {
                c.reject(err);
            } finally {
                this._paQueueTimer = setTimeout(() => {
                    this._paCmdQueueNext();
                }, 100);
            }
        }
    }

    /**
     * Get device ip Address
     */
    _getIP () {
        return new Promise((resolve, reject) => {
            let interfaces = os.networkInterfaces();
            Object.values(interfaces).forEach(iface => {
                for (var i = 0; i < iface.length; i++) {
                    var alias = iface[i];
                    if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal)
                        resolve(alias.address);
                }
            })
        })
    }
}

module.exports = Router;