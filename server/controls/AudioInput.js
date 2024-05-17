let _paAudioSourceBase = require('./_paAudioSourceBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const _paNullSinkBase = require('./_paNullSinkBase');

class AudioInput extends _paNullSinkBase {
    constructor() {
        super();
        // Set audio format settings to read-only. These settings are read / calculated from the PulseAudio server, and cannot be modified by the user.
        this.SetAccess('channels', { Set: 'none' });
        this.SetAccess('bitDepth', { Set: 'none' });
        this.SetAccess('sampleRate', { Set: 'none' });
        this.channelMap = '';       // Input channel map
        this._channelMap = '';      // PulseAudio calculated channel map
        this._srcChannels = 0;      // Master source channel count
        this._srcChannelMap = [];   // Master source channel map
        this.master = '';           // PulseAudio master source
        this._paModuleID_ = undefined;  // Ramap module id
        this._loopbackID = undefined;  // Loopback module id
        this._remapSource = undefined;   // name of remap
    }

    Init() {
        super.Init();

        this._remapSource = this._paModuleName + "_remap";
        // this.monitor = this.source;

        this.on('run', run => {

            let eventHandler = function (sources) {
                if (sources.find(t => t.name == this.master)) {
                    if (!this._paModuleID_) {
                        this._map();
                        this._parent.PaCmdQueue(() => { this._startRemapSource() });
                    }
                } else {
                    this._parent.PaCmdQueue(() => { this._stopRemapSource() });
                }
            }.bind(this);

            if (run) {
                // start loopback if run && _paModuleID_ exists
                if (this._paModuleID_) this._startLoopback();
                // Wait for master source to be available before starting the remap source
                this._parent.on('sources', eventHandler, { immediate: true });
            } else {
                this._parent.off('sources', eventHandler);
            }
        });

        this._parent.on('sources', sources => {
            // listen for map-source module creation
            if (sources.find(t => t.name == this._paModuleName)) {
                this.ready = true;
            } else {
                this.ready = false;
            }

            this._map();
        }, { immediate: true });

        this.on('channelMap', () => {
            this._map();
        });

        this.on('master', () => {
            this._map();
        });
    }

    /**
     * Calculates and sets this.channels and this._channelMap from this.channelMap
     */
    _map() {
        if (this._parent._sources[this.master]) {
            this._srcChannels = this._parent._sources[this.master].channels;
            this._srcChannelMap = this._parent._sources[this.master].channelmap;
            this.sampleRate = this._parent._sources[this.master].sampleRate;
            this.bitDepth = this._parent._sources[this.master].bitDepth;

            let masterMap = [];
            let channelCount = 0;
            let channelMap = [];

            this.channelMap.split(',').forEach(channel => {
                let ch = parseInt(channel);
                if (ch && ch > 0 && ch <= this._srcChannels) {
                    masterMap.push(this._srcChannelMap[ch - 1]);
                    channelMap.push(ch);
                    channelCount++;
                }
            });

            // Reduce channel count if larger than master channel count
            if (channelCount > this._srcChannels) {
                channelCount = this._srcChannels;
                channelMap.splice(channelCount);
            }

            if (channelCount > 0) {
                this._channelMap = `master_channel_map=${masterMap.join(',')} channel_map=${this._srcChannelMap.slice(0, channelCount).join(',')}`
                this.channels = channelCount;
                this.channelMap = channelMap.join(',');
            } else {
                // Create default channel map
                channelMap = [];
                for (let i = 1; i <= this._srcChannels; i++) {
                    channelMap.push(i);
                }
                this.channelMap = channelMap.join(',');

                // Regenerate map
                this._map();
            }
        }
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startRemapSource() {
        if (this.channels > 0) {
            let cmd = `pactl load-module module-remap-source master=${this.master} source_name=${this._remapSource} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} ${this._channelMap} remix=no source_properties="latency_msec=${this._parent.paLatency}"`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    this._parent._log('ERROR', data.stderr.toString());
                }

                if (data.stdout.length) {
                    this._paModuleID_ = data.stdout.toString().trim();
                    this._parent._log('INFO', `${this._controlName} (${this.displayName}): Created remap-source; ID: ${this._paModuleID_}`);
                    // start loopback
                    this._startLoopback();
                }
            }).catch(err => {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): ` + err.message);
                this._paModuleID_ = undefined;
            });
        } else {
            this._parent._log('ERROR', `${this._controlName} (${this.displayName}): Unable to create remap-source: Invalid channel map`);
            this._paModuleID_ = undefined;
        }

    }

    _startLoopback() {
        //  start loopback from device to null sink
        let channelMap = '';
        if (this.channels == 1) channelMap = 'channel_map=mono'
        let cmd = `pactl load-module module-loopback source=${this._remapSource} sink=${this.sink} latency_msec=${this._parent.paLatency} channels=${this.channels} rate=${this.sampleRate} format=s${this.bitDepth}le source_dont_move=true sink_dont_move=true ${channelMap}`;
        exec(cmd, { silent: true }).then(data => {
            if (data.stderr) {
                this._parent._log('ERROR', `${this._controlName}: ${data.stderr.toString()}`);
            }

            if (data.stdout.length) {
                this._loopbackID = data.stdout.toString().trim();
                this._parent._log('INFO', `${this._controlName}: Connected ${this._remapSource} to ${this.sink}; ID: ${this._loopbackID}`);
            }
        }).catch(err => {
            this._parent._log('FATAL', `${this._controlName}: ${err.message}`);
        });
    }

    // Remove PulseAudio module
    _stopRemapSource() {
        if (this._paModuleID_) {
            let cmd = `pactl unload-module ${this._paModuleID_}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    this._parent._log('ERROR', data.stderr.toString());
                } else {
                    this._parent._log('INFO', `${this._controlName} (${this.displayName}): Removed remap-source`);
                }

                this._paModuleID_ = undefined;
            }).catch(err => {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): ` + err.message);
                this._paModuleID_ = undefined;
            });
        }
    }
}

module.exports = AudioInput;