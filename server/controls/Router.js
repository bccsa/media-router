let { dm } = require('../modular-dm');
const util = require('util');
const spawn = require('child_process').spawn;
const exec = util.promisify(require('child_process').exec);
const os_utils = require('os-utils');
const os = require('os');
const fs = require('fs');
const path = require('path');
const psTree = require('ps-tree');

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
        this.logMessage = [];                       // Last log message
        this.SetAccess('logMessage', { Set: 'none' });// Disable Set() access to prevent frontend changing the property
        this.log = [];                              // complet list of recent logs
        this.SetAccess('log', { Set: 'none' });     // Disable Set() access to prevent frontend changing the property
        this.logLimit = 100;                        // max amout of logs in list
        this.fetchLog = false;                      // Toggle from fron end to fetch log on page load
        this.restartCmd = false;                    // Router restart command. Router process needs passwordless sudo access to the followng command: "sudo reboot now"
        this.resetCmd = false;                      // Router process reset command. Kills the router.js process. Process should be restarted externally (e.g. via systemd service)
        this.startLocalCTR = false;                 // Start local control panel on startup (When the MR starts) (!!! This script was build for bookworm / noble / bullseye, if you have a diffrent release update teh script in ./media-router/server/script/startLocalCTR.sh)
        this._paQueue = [];                         // PulseAudio command rate limiter callback queue
        this._paConnectionCount = 0                 // PulseAudio connection counter
        this.startupDelayTime = 3000;               // Startup delay time in milliseconds. This is sometimes needed to give other services (e.g. PulseAudio) sufficient time to start up.
        this.startupState = true;                   // true = Auto (manager selected state); false = Start in stopped state.
        this.cpuUsage = 0;                          // CPU usage indication
        this.ipAddress = "127.0.0.1";               // system IP address    
        this.buildNumber = "DEV";                   // Software Build number
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

        // Load Build Number (Timeout is to run this on the next tick to otherwise it does not sync through to the manager)
        setTimeout(() => { 
            try {
                this.buildNumber = fs.readFileSync(path.join(__dirname, '../../build-number.txt'), 'utf8').toString().replace(/\r?\n|\r/g, "");
            }
            catch (err) {
                this._log('ERROR', 'Unable to load build numebr: ' + err.message);
                this.buildNumber = 'DEV';
            }
        }, 5000);
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
                this._log('INFO', 'Restarting Pipewire');
                exec('systemctl --user restart pipewire').catch((err) => {
                    this._log('ERROR', 'Unable to restart pipewire: ' + err.message);
                });
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

        // Start Local Control panel
        let _startLocalCTR_process = undefined;
        this.on('startLocalCTR', s => {
            if (s && !_startLocalCTR_process) {
                this._log('INFO', 'Starting local control panel');
                _startLocalCTR_process = spawn(`bash`, [`${path.join(__dirname, '../scripts/start-localCTR.sh')}`]);
                // standard stderr handeling
                _startLocalCTR_process.stdout.on('data', (data) => {
                    this._log('ERROR', `Unable to start local control panel: ${data}`);
                });
                // _startLocalCTR_process = exec(`bash ${path.join(__dirname, '../scripts/start-localCTR.sh')}`).catch(err => {
                //     this._log('ERROR', 'Unable start local control panel: ' + err.message);
                // });
            } else if (!s && _startLocalCTR_process) {
                this._log('INFO', 'Stopping local control panel');
                _startLocalCTR_process.stdin.pause();
                let _this = this;
                let pid = _startLocalCTR_process.pid;
                psTree(pid, function (err, children) { // Solution found here: https://stackoverflow.com/questions/18694684/spawn-and-kill-a-process-in-node-js
                    [pid].concat(
                        children.map(function (p) {
                            return p.PID;
                        })
                    ).forEach((tpid) => {
                        try { process.kill(tpid, "SIGKILL") }
                        catch (ex) { _this._log('FATAL', `${_this._controlName} (${_this.displayName}): ${ex.message}`) }
                    });
                });
                _startLocalCTR_process = undefined;
            }
        }, { immediate: true });

        // toggle on front end to emit the log
        this.on('fetchLog', res => {
            if (res) {
                this.NotifyProperty('log');
                this.fetchLog = false;
            }
        })
    }

    /**
     * Gets a list of PulseAudio items in json format.
     * @param {string} type - Valid type are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @returns - Promise
     */
    _getPA(type) {
        function get(type) {
            return new Promise((resolve, reject) => {
                exec('pactl -fjson list ' + type, { silent: true }).then(data => {
                    if (data.stderr) reject(stderr);
                    let arr = [];
                    try {arr = JSON.parse(data.stdout)} catch (err) { this._log('ERROR', `${_this._controlName} (${_this.displayName}): ${err.message}`); }
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
        return new Promise(async (resolve, reject) => {
            try {
                await this._getPA(type).then(async data => {
                    let active = {};
                    let updated = false;

                    // Add new items to dst
                    for (const item of Object.values(data)) {
                        if (item.name) {
                            // Mark item as active
                            active[item.name] = true;

                            // Add to dst if not existing
                            if (!dst[item.name]) {
                                let ch = item['sample_specification'].match(/[0-9][0-9]*ch/gi);
                                if (ch[0]) ch = parseInt(ch[0].match(/[0-9][0-9]*/gi));

                                let bitDepth = item['sample_specification'].match(/(float|[sf])\d{1,2}[a-z]{0,2}/gi);
                                if (bitDepth[0]) bitDepth = parseInt(bitDepth[0].match(/[0-9][0-9]*/gi));

                                let sampleRate = item['sample_specification'].match(/[1-9]\d*Hz/gi);
                                if (sampleRate[0]) sampleRate = parseInt(sampleRate[0].match(/[0-9][0-9]*/gi));

                                // description
                                let description = item.description;
                                let descIteration = 0;
                                while (Object.values(dst).find(t => t.description == description) != undefined) {
                                    descIteration++;
                                    description = `${item.description} (${descIteration})`;
                                }

                                if (item.description && typeof ch === 'number' && ch > 0) {
                                    dst[item.name] = {
                                        name: item.name,
                                        description: description,
                                        channels: ch,
                                        bitDepth: bitDepth,
                                        sampleRate: sampleRate,
                                        monitorsource: item['monitor_source'],
                                        channelmap: item['channel_map'].split(','),
                                        cardId: item.properties["alsa.card"]
                                        // mute: item.mute,
                                    };
                                }

                                // set alsa input / output / auto gain control
                                await this._setAlsaInputDefaults(item.properties["alsa.card"]);

                                updated = true;
                                this._log('INFO', `PulseAudio ${type} detected: ${item.name}`);
                            }
                        }
                    };

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
     * Set alsa device input / output gain by default to 100% and auto gain control to off
     * @param {*} cardId - alsa device card id
     */
    async _setAlsaInputDefaults(cardId) {
        return new Promise((resolve, reject) => {
            if (!cardId || cardId == undefined) resolve();
            else
            exec(`amixer -c ${cardId} controls`).then(async result => {
                if (!result.stdout) return;
                let controls = result.stdout.split('\n');
                for (const control of controls) {
                    if (control.indexOf('Capture Volume') >= 0) {
                        await exec(`amixer -c ${cardId} cset ${control} 100%`).catch(err => {
                            this._log('ERROR', 'Unable to set alsa input volume to 100%: ' + err.message);
                        });
                    } else if (control.indexOf('Playback Volume') >= 0 && !(control.indexOf('Mic Playback Volume') >= 0)) {
                        await exec(`amixer -c ${cardId} cset ${control} 100%`).catch(err => {
                            this._log('ERROR', 'Unable to set alsa output volume to 100%: ' + err.message);
                        });
                    } else if (control.indexOf('Auto Gain Control') >= 0) {
                        await exec(`amixer -c ${cardId} cset ${control} off`).catch(err => {
                            this._log('ERROR', 'Unable to set alsa auto gain control to off: ' + err.message);
                        });
                    }
                }
                resolve();
            }).catch(err => {
                this._log('ERROR', 'Unable to set alsa input defaults: ' + err.message);
            })
        })
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
        this.logMessage = msg;
        this.log.push(msg);
        // clear old log items when log is full
        while (this.log.length > this.logLimit) {this.log.shift()}; 
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

            if (this._paQueue.length == 1) this.paCmdQueueNext();   // Start queue processing on first entry
        });
    }

    /**
     * Execute the next callback from the pulseaudio command rate limiter queue
     */
    paCmdQueueNext() {
        if (this._paQueue.length > 0) {
            let c = this._paQueue[0]
            try {
                // Execute callback from queue
                c.callback();
                c.resolve();
            } catch (err) {
                c.reject(err);
            } 
            setTimeout(() => {
                this._paQueue.shift();
                this.paCmdQueueNext();
            }, 200)
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