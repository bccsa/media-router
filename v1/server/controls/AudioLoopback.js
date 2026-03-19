let { dm } = require('../modular-dm');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * PulseAudio Loopback module. This control connects a control's PulseAudio source to another control's PulseAudio sink
 * The source and destination controls must be passed to this control on creation through parent.Set().
 */
class AudioLoopback extends dm {
    constructor() {
        super();
        this.srcControl = "";   // Audio input control
        this._src = undefined;
        this.dstControl = "";   // Audio output control
        this._dst = undefined;
        this._paModuleID;   // PulseAudio module instance ID
        this.run = false;   // Set to true to start; Set to false to stop;
        this.hideData = true;
        this._srcReady = false;
        this._srcRun = false;
        this._dstReady = false;
        this._dstRun = false;
        this.ready = false;
        this._router;
        this._srcChannelMap = "";
        this.channels = 0;
    }

    Init() {
        this._router = this._parent._parent;
        this._src = this._router[this.srcControl];
        this._dst = this._router[this.dstControl];

        if (this._src && this._dst) {
            // Subscribe to source and destination events
            let o = this;
            this.on('run', this._setReady.bind(this), { immediate: true });
            this._src.on('ready', ready => { o._srcReady = ready; o._setReady(); }, { immediate: true, caller: this });
            this._src.on('run', run => { o._srcRun = run; o._setReady(); }, { immediate: true, caller: this });
            this._dst.on('ready', ready => { o._dstReady = ready; o._setReady(); }, { immediate: true, caller: this });
            this._dst.on('run', run => { o._dstRun = run; o._setReady(); }, { immediate: true, caller: this });
        } else {
            this._router._log('ERROR', `${this._controlName}: Invalid source or destination.`);
        }

        this.on('ready', ready => {
            if (ready) {
                this._parent._parent.PaCmdQueue(() => {
                    this._startLoopback();
                });
            } else {
                this._parent._parent.PaCmdQueue(() => {
                    this._stopLoopback();
                });
            }
        }, { immediate: true });
    }

    _setReady() {
        this.ready = this.run && this._srcReady && this._dstReady && this._srcRun && this._dstRun;
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startLoopback() {
        if (this._src && this._src.source && this._dst && this._dst.sink) {
            this._srcMap()
            // mute dest to avoid loud sound when loopback connenect
            this._dst._setMute(true);

            let sampleRate = this._dst.sampleRate;
            let bitDepth = this._dst.bitDepth;
            let channels = this._dst.channels;
            let channelMap = '';
            if (channels == 1) channelMap = 'channel_map=mono'

            // Only PipeWire supports setting the loopback_name (needed for filtering dynamically created PulseAudio modules on systems using PipeWire).
            let _loopbackName = "";
            if (this._parent._paServerType == 'PipeWire') _loopbackName = `loopback_name=${this._paModuleName}`;

            let cmd = `pactl load-module module-loopback ${_loopbackName} source=${this._src.source} sink=${this._dst.sink} latency_msec=${this._router.paLatency} channels=${channels} rate=${sampleRate} format=s${bitDepth}le source_dont_move=true sink_dont_move=true ${channelMap}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    this._router._log('ERROR', `${this._controlName}: ${data.stderr.toString()}`);
                }

                if (data.stdout.length) {
                    this._paModuleID = data.stdout.toString().trim();
                    this._router._log('INFO', `${this._controlName}: Connected ${this._src.source} to ${this._dst.sink}; ID: ${this._paModuleID}`);
                }
                setTimeout(() => { this._dst._setMute(this._dst.mute) }, 200); // restore destination mute 
            }).catch(err => {
                this._router._log('FATAL', `${this._controlName}: ${err.message}`);
                this._dst._setMute(this._dst.mute);
            });
        } else {
            this._router._log('ERROR', `${this._controlName}: Unable to connect source to sink: Invalid source or sink`)
        }
    }

    // Remove PulseAudio module
    _stopLoopback() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    this._router._log('ERROR', `${this._controlName}: ${data.stderr.toString()}`);
                } else {
                    this._router._log('INFO', `${this._controlName}: Disconnected ${this._src.source} from ${this._dst.sink}`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                this._router._log('FATAL', `${this._controlName}: ${err.message}`);
            });
        }
    }

     /**
     * Calculates and sets this.channels and this._channelMap from this.channelMap
     */
    _srcMap() {
        if (this._src && this._dst) {
            let _srcChannels = this._src.channels;
            let _srcChannelMap = this._dst.srcChannelMap;

            let masterMap = [];
            let channelCount = 0;
            let channelMap = [];

            _srcChannelMap.split(',').forEach(channel => {
                let ch = parseInt(channel);
                if (ch && ch > 0 && ch <= _srcChannels) {
                    masterMap.push(_srcChannelMap[ch - 1]);
                    channelMap.push(ch);
                    channelCount++;
                }
            });

            // Reduce channel count if larger than master channel count
            if (channelCount > _srcChannels) {
                channelCount = _srcChannels;
                channelMap.splice(channelCount);
            }

            if (channelCount > 0) {
                this._srcChannelMap = `channel_map=${masterMap.join(',')}`;
                this.channels = channelCount;
                this._dst.srcChannelMap = channelMap.join(',');
            } else if (this.channels.channels == 1 && channelCount > 1) { 
                this._srcChannelMap = `channel_map=mono`
            } else {
                // Create default channel map
                channelMap = [];
                for (let i = 1; i <= _srcChannels; i++) {
                    channelMap.push(i);
                }
                this._dst.srcChannelMap = channelMap.join(',');

                // Regenerate map
                this._srcMap();
            }
        }
    }
}

module.exports = AudioLoopback;