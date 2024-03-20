/**
 * Base class for processing base srt functions
*/

const { spawn } = require('child_process');

/**
 * SrtBase Class, used as a base class for all shared SRT function
 */
class SrtBase {
    constructor() {
        this._gst;
        this.srtHost = 'srt';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 1;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtMaxBw = 8000;       // not implemented in server yet
        this.caller_count = 0;      // amount of callers connected to module

        // local variables 
        this._prev_caller = 0;      // previous caller count
    }

    /**
     * Create a URI used by SRT
     * @returns - A URI used for srt
     */
    uri() {
        let crypto = '';
        if (this.srtPassphrase) { crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}` };

        let streamID = '';
        if (this.srtStreamID) { streamID = '&streamid=' + this.srtStreamID };

        let _uri = `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${streamID}${crypto}`;

        return _uri;
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashink the whole process when the c++ proccess crashes)
     * @param {String} path - path to child process
     * @param {Array} args - List of process arguments to pass
     */
    _start_gst(path, args) {
        if (!this._gst) {
            try {
                let _this = this;

                this._gst = spawn('node', [path, ...args], {cwd: "./", stdio: [null, null, null, 'ipc']} );

                // standart stdout handeling
                this._gst.stdout.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standart stderr handeling
                this._gst.stderr.on('data', (data) => {
                    _this._parent._log('ERROR', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standart stdin handeling
                this._gst.stdin.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });

                // standart message handeling
                this._gst.on('message', (data) => {
                    if (this._controls)
                    _this._stats(data);
                });
                
                // Restart pipeline on exit
                this._gst.on('exit', (data) => {
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Got exit code, restarting in 3s`);
                    this._stop_gst();
                    setTimeout(() => { if (this.ready && this.run) { this._start_gst() } }, 3000);
                });

            }
            catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): opus decoder (gstreamer) error ${err.message}`);
                this._stop_gst();
            }
        }
    }

    /**
     * Stop spawned node process
     */
    _stop_gst() {
        if (this._gst) {
            this._gst.stdin.pause();
            this._gst.kill();
            this._gst = undefined;
        }
        // set all child controls as disconnected 
        this.caller_count = 0;
        if (this._controls)
        Object.values(this._controls).forEach(c => { c.status = "disconnected" });
    }

    /**
     * Process statistics
     * @param {String} stats - Json object with statistics 
     */
    _stats(stats, caller = 0) {
        this.caller_count = caller;
        let _calcRemoveCallers = false; // determine if callers should be recalcated
        // list of usefull stats linked to their class property
        let props = {
            "rtt-ms"                : "rtt_ms",
            "bandwidth-mbps"        : "available_bandwidth",
            "bytes-received"        : "bytes_received",
            "bytes-sent"            : "bytes_sent",
            "packets-received"      : "packets_received",
            "packets-received-lost" : "packets_received_lost",
            "packets-sent"          : "packets_sent",
            "packets-sent-lost"     : "packets_sent_lost",
            "receive-rate-mbps"     : "receive_rate_mbps",
            "send-rate-mbps"        : "send_rate_mbps",
            "send-duration-us"      : "send_duration_us"
        }

        let obj = {};
        let _c = 0;
        Object.keys(stats).forEach(key => {
            if (typeof stats[key] === "object") {
                _c ++;
                this._stats(stats[key], _c);
                _calcRemoveCallers = true;
            } else {
                if (props[key])
                obj[props[key]] = stats[key];
            }
        })

        let ctr_name = `${this._controlName}_${caller}`;

        // Create stat controls
        if (Object.keys(obj).length > 0) {
            obj.controlType = "SrtStats";
            obj.status = "running";
            obj.StatsName = `${this.displayName}`; 
            if (this.srtMode == 'listener') {obj.StatsName += `: ${caller}`}; // only add caller if in listener mode 
            this.Set({[ctr_name]: obj});
            this._notify({[ctr_name]: this[ctr_name].Get()});;
        }
        // set control status to disconnected 
        else {
            if (this._controls[ctr_name])
            this._controls[ctr_name].status = "disconnected";
            this._removeCallers();
        }

        if (_calcRemoveCallers) {
            if (this._prev_caller != _c) {
                setTimeout(() => {this._removeCallers()}, 100);
            }
            this._prev_caller = _c;
        }
    }

    /**
     * removes old callers from the list 
     */
    _removeCallers() {
        let count = 0; 
        if (this._controls && this.srtMode == "listener")
        Object.values(this._controls).forEach(c => {
            if (count >= this.caller_count) {
                c._notify({remove: true}); c.Set({remoce: true})
            }
            count ++;
        });
    }
}

module.exports = SrtBase;