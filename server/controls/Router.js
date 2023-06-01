let { dm } = require('../modular-dm');
const util = require('util');
const exec = util.promisify(require('child_process').exec);


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
        this.sources = [];
        this.sinks = [];
    }

    Init() {
        this.getPAarr('sources').then(data => {
            this.sources = data;
        });
        this.getPAarr('sinks').then(data => {
            this.sinks = data;
        });
    }

    /**
     * Gets a list of PulseAudio items in json format.
     * @param {string} type - Valid type are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @returns - Promise
     */
    getPA(type) {
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
     * Gets a simple array of PulseAudio items
     * @param {string} type - Valid types are modules, sinks, sources, sink-inputs, source-outputs, clients, samples, cards
     * @returns - Promise
     */
    getPAarr(type) {
        return new Promise((resolve, reject) => {
            this.getPA(type).then(data => {
                let arr = [];
                Object.values(data).forEach(item => {
                    let ch = item['Sample Specification'].match(/[0-9][0-9]*ch/gi);
                    if (ch[0]) ch = parseInt(ch[0].match(/[0-9][0-9]*/gi));
                    if (item.Name && item.Description && typeof ch === 'number' && ch > 0) {
                        arr.push({
                            name: item.Name,
                            description: item.Description,
                            channels: ch,
                            monitorsource: item['Monitor Source']
                        });
                    }
                });

                resolve(arr);
            }).catch(err => {
                reject(err);
            });
        });
    }
}

module.exports = Router;