/**
 * Base class for processing base srt functions
 */

const GstBase = require("./GstBase");

/**
 * SrtBase Class, used as a base class for all shared SRT function
 */
class SrtBase extends GstBase {
    constructor() {
        super();
        this.srtHost = "";
        this.srtPort = 1234;
        this.srtMode = "caller";
        this.srtLatency = 1;
        this.srtStreamID = "";
        this.srtPbKeyLen = 16;
        this.srtPassphrase = "";
        this.srtMaxBw = 250; // % of bandwidth
        this.srtEnableMaxBW = false; // Enable MaxBandwidth property for srt
        this.caller_count = 0; // amount of callers connected to module

        // local variables
        this._prev_caller = 0; // previous caller count
        this._statsInterval = undefined;
    }

    /**
     * Create a URI used by SRT
     * @returns - A URI used for srt
     */
    uri() {
        let crypto = "";
        if (this.srtPassphrase && this.srtPassphrase.length >= 10) {
            crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`;
        } else if (this.srtPassphrase && this.srtPassphrase.length < 10) {
            this._parent._log(
                "ERROR",
                `${this._controlName} (${this.displayName}): SRT Passphrase need to be 10 or more characters, Encryption not enabled`
            );
        }

        let streamID = "";
        if (this.srtStreamID) {
            streamID = `&streamid=${this.srtStreamID}`;
        }

        let maxBW = "";
        if (this.srtEnableMaxBW) {
            maxBW = `&maxbw=${
                (Math.round(this.calcBitrate() / 8) * this.srtMaxBw) / 100
            }`;
        }
        const _host = this.srtMode == "listener" ? "0.0.0.0" : this.srtHost;
        let _uri = `srt://${_host}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}${maxBW}${streamID}${crypto}`;

        return _uri;
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashink the whole process when the c++ proccess crashes)
     * @param {String} cmd - command to exe
     * @param {String} _srtElementName - name of srt element to poll for stats
     */
    _start_srt(cmd, _srtElementName) {
        // clear old stats data
        this._clearStats();
        // Listen on srt stats
        this.on("SrtStats", (data) => {
            if (this._controls && data) {
                let _c = 0;
                this.caller_count = Object.keys(data).length - 1;
                Object.keys(data).forEach((key) => {
                    if (typeof data[key] === "object") {
                        _c++;
                        this._stats(data[key], _c);
                    } else {
                        this._stats(data, 0);
                    }
                });

                // remove old stat rows
                if (this._prev_caller != this.caller_count) {
                    setTimeout(() => {
                        this._removeCallers();
                    }, 100);
                }
                this._prev_caller = this.caller_count;
            }
        });

        if (this.srtHost || this.srtMode == "listener") {
            this.start_gst(cmd);
        } else {
            this._parent._log(
                "ERROR",
                `${this._controlName} (${this.displayName}): Unable to start, Please enter a valid SrtHost`
            );
        }

        // Poll for srt stats
        this._statsInterval = setInterval(() => {
            if (_srtElementName)
                this.get_gst_SrtStats("SrtStats", _srtElementName);
        }, 1000);
    }

    /**
     * Stop spawned node process
     */
    _stop_srt() {
        clearInterval(this._statsInterval); // clear stats interval
        this.stop_gst();
        // set all child controls as disconnected
        this.caller_count = 0;
        if (this._controls)
            Object.values(this._controls).forEach((c) => {
                c.status = "disconnected";
            });
    }

    /**
     * Process statistics
     * @param {String} stats - Json object with statistics
     */
    _stats(stats, caller = 0) {
        // list of usefull stats linked to their class property
        let props = {
            "rtt-ms": "rtt_ms",
            "bandwidth-mbps": "available_bandwidth",
            "bytes-received": "bytes_received",
            "bytes-sent": "bytes_sent",
            "packets-received": "packets_received",
            "packets-received-lost": "packets_received_lost",
            "packets-sent": "packets_sent",
            "packets-sent-lost": "packets_sent_lost",
            "receive-rate-mbps": "receive_rate_mbps",
            "send-rate-mbps": "send_rate_mbps",
            "send-duration-us": "send_duration_us",
        };

        let obj = {};
        Object.keys(stats).forEach((key) => {
            if (props[key]) obj[props[key]] = stats[key];
        });

        let ctr_name = `${this._controlName}_${caller}`;

        // Create stat controls
        if (Object.keys(obj).length > 0) {
            obj.controlType = "SrtStats";
            obj.status = "running";
            obj.StatsName = `${this.displayName}`;
            if (this.srtMode == "listener") {
                obj.StatsName += `: ${caller}`;
            } // only add caller if in listener mode
            this.Set({ [ctr_name]: obj });
            this._notify({ [ctr_name]: this[ctr_name].Get() });
        }
        // set control status to disconnected
        else {
            if (this._controls[ctr_name])
                this._controls[ctr_name].status = "disconnected";
        }
    }

    /**
     * removes old callers from the list
     */
    _removeCallers() {
        let count = 0;
        if (this._controls && this.srtMode == "listener")
            Object.values(this._controls).forEach((c) => {
                if (c.controlType == "SrtStats") {
                    if (count >= this.caller_count) {
                        c._notify({ remove: true });
                        c.Set({ remove: true });
                    }
                    count++;
                }
            });
    }

    /**
     * Clear all stats on restart
     */
    _clearStats() {
        if (this._controls)
            Object.values(this._controls).forEach((c) => {
                if (c.controlType == "SrtStats") c._notify({ remove: true });
                c.Set({ remoce: true });
            });
    }
}

module.exports = SrtBase;
