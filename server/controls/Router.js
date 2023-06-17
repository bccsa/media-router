let { dm } = require('../modular-dm');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * Router control
 */
class Router extends dm {
    /**
     * @param {string} path - path to modular-dm control class files. This should be the absolute path to the control files directory or the relative path from the directory where modular-dm is installed.
     */
    constructor(path) {
        super(path);
        this.run = false;
        this.autoStart = false;
        this.autoStartDelay = 500,
        this.DisplayName = "";                      // Used as router username
        this.password = "";
        this._sources = {};
        this._sinks = {};
        this.sources = [];                        // json sources list for front-end
        this.SetAccess('sources', { Set: 'none' }); // Disable Set() access to prevent frontend changing the property
        this.sinks = [];                           // json sinks list for front-end
        this.SetAccess('sinks', { Set: 'none' });   // Disable Set() access to prevent frontend changing the property
        this._udpSocketPortIndex = 2000;
    }

    Init() {
        super.Init();

        // reset run without triggering event
        this._properties.run = false;
        
        // Auto start
        if (this.autoStart) {
            setTimeout(() => {
                this.run = true;
            }, this.autoStartDelay);
        }

        // PulseAudio items detection
        if (this._updatePAlist('sources', this._sources)) this.sources = Object.values(this._sources);
        if (this._updatePAlist('sinks', this._sinks)) this.sinks = Object.values(this._sinks);
        setInterval(() => { if (this._updatePAlist('sources', this._sources)) this.sources = Object.values(this._sources) }, 1000);
        setInterval(() => { if (this._updatePAlist('sinks', this._sinks)) this.sinks = Object.values(this._sinks) }, 1000);

        // Start/stop submodules
        this.on('run', run => {
            Object.values(this._controls).forEach(control => {
                if (control.run != undefined) {
                    control.run = run;
                }
            });
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
     * @returns {boolean} - Returns true if the destination object (dst) has been updated
     */
    async _updatePAlist(type, dst) {
        try {
            let data = await this._getPA(type);
            let active = {};
            let updated = false;

            // Add new items to dst
            Object.values(data).forEach(item => {
                if (item.Name) {
                    // Mark item as active
                    active[item.Name] = true;

                    // Add to dst if not existing
                    if (!dst[item.Name]) {
                        // channel number
                        let ch = item['Sample Specification'].match(/[0-9][0-9]*ch/gi);
                        if (ch[0]) ch = parseInt(ch[0].match(/[0-9][0-9]*/gi));

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
                                monitorsource: item['Monitor Source'],
                                channelmap: item['Channel Map'].split(','),
                            };
                        }

                        updated = true;
                        console.log(`PulseAudio ${type} detected: ${item.Name}`);
                    }
                }
            });

            // Remove old items from dst
            Object.keys(dst).forEach(itemName => {
                if (!active[itemName]) {
                    delete dst[itemName];
                    updated = true;
                    console.log(`PulseAudio ${type} removed: ${itemName}`);
                }
            });

            return updated;
        } catch (err) {
            console.log(err.message);
            return false;
        }
    }

    /**
     * Get next available UDP socket port
     */
    GetUdpSocketPort() {
        this._udpSocketPortIndex++;
        return this._udpSocketPortIndex;
    }
}

module.exports = Router;