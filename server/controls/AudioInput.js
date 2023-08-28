let _paAudioSourceBase = require('./_paAudioSourceBase');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

class AudioInput extends _paAudioSourceBase {
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
    }

    Init() {
        super.Init();

        this.source = this._controlName;
        this.monitor = this.source;

        this.on('run', run => {
            if (run) {
                this._startRemapSource();
            } else {
                this._stopRemapSource();
            }
        });

        this._parent.on('sources', sources => {
            // listen for map-source module creation
            if (sources.find(t => t.name == this._controlName)) {
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
            let cmd = `pactl load-module module-remap-source master=${this.master} source_name=${this._controlName} format=s${this.bitDepth}le rate=${this.sampleRate} channels=${this.channels} ${this._channelMap} remix=no`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                }

                if (data.stdout.length) {
                    this._paModuleID = data.stdout.toString().trim();
                    console.log(`${this._controlName} (${this.displayName}): Created remap-source; ID: ${this._paModuleID}`);
                }
            }).catch(err => {
                console.log(err.message);
            });
        } else {
            console.log(`${this._controlName} (${this.displayName}): Unable to create remap-source: Invalid channel map`);
        }

    }

    // Remove PulseAudio module
    _stopRemapSource() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.log(data.stderr.toString());
                } else {
                    console.log(`${this._controlName} (${this.displayName}): Removed remap-source`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.log(err.message);
            });
        }
    }
}

module.exports = AudioInput;