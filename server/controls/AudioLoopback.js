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
    }

    Init() {
        let router = this._parent._parent;
        this._src = router[this.srcControl];
        this._dst = router[this.dstControl];

        // let srcRdyEventHandler = function (ready) { this._srcReady = ready; this._setReady(); }.bind(this);
        // let srcRunEventHandler = function (run) { this._srcRun = run; this._setReady(); }.bind(this);
        // let dstRdyEventHandler = function (ready) { this._dstReady = ready; this._setReady(); }.bind(this);
        // let dstRunEventHandler = function (run) { this._dstRun = run; this._setReady(); }.bind(this);

        if (this._src && this._dst) {
            // Subscribe to source and destination events
            let o = this;
            this.on('run', this._setReady.bind(this), { immediate: true });
            this._src.on('ready', ready => { o._srcReady = ready; o._setReady(); }, { immediate: true, caller: this });
            this._src.on('run', run => { o._srcRun = run; o._setReady(); }, { immediate: true, caller: this });
            this._dst.on('ready', ready => { o._dstReady = ready; o._setReady(); }, { immediate: true, caller: this });
            this._dst.on('run', run => { o._dstRun = run; o._setReady(); }, { immediate: true, caller: this });

            // Unsubscribe from events on control removal;
            // this.on('remove', (c) => {
            //     c._src.off('ready', srcRdyEventHandler);
            //     c._src.off('run', srcRunEventHandler);
            //     c._dst.off('ready', dstRdyEventHandler);
            //     c._dst.off('run', dstRunEventHandler);
            // });
        } else {
            console.log(`${this._controlName}: Invalid source or destination.`);
        }

        this.on('ready', ready => {
            if (ready) {
                this._startLoopback();
            } else {
                this._stopLoopback();
            }
        }, { immediate: true });
    }

    _setReady() {
        this.ready = this.run && this._srcReady && this._dstReady && this._srcRun && this._dstRun;
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startLoopback() {
        if (this._src && this._src.source && this._dst && this._dst.sink) {
            let cmd = `pactl load-module module-loopback source=${this._src.source} sink=${this._dst.sink} latency_msec=1 channels=${this._src.channels}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.error(`${this._controlName}: ${data.stderr.toString()}`);
                }

                if (data.stdout.length) {
                    this._paModuleID = data.stdout.toString().trim();
                    console.log(`${this._controlName}: Connected ${this._src.source} to ${this._dst.sink}; ID: ${this._paModuleID}`);
                }
            }).catch(err => {
                console.error(`${this._controlName}: ${err.message}`);
            });
        } else {
            console.log(`${this._controlName}: Unable to connect source to sink: Invalid source or sink`)
        }
    }

    // Remove PulseAudio module
    _stopLoopback() {
        if (this._paModuleID) {
            let cmd = `pactl unload-module ${this._paModuleID}`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    console.error(`${this._controlName}: ${data.stderr.toString()}`);
                } else {
                    console.log(`${this._controlName}: Disconnected ${this._src.source} from ${this._dst.sink}`);
                }

                this._paModuleID = undefined;
            }).catch(err => {
                console.error(`${this._controlName}: ${err.message}`);
            });
        }
    }
}

module.exports = AudioLoopback;