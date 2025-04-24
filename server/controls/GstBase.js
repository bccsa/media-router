/**
 * Base class for processing base gstreamer functions
 */
const Spawn = require("./spawn");

/**
 * SrtBase Class, used as a base class for all shared SRT function
 */
class GstBase extends Spawn {
    constructor() {
        super();
        this.gstMessage = "";
        this.gstMessageData = undefined;
        this.start_gst = this._start_gst; // need to map that child class can access function
        this.stop_gst = this._stop_gst; // need to map that child class can access function
        this.set_gst = this._set_gst; // need to map that child class can access function
        this.get_cmd_SrtStats = this._get_cmd_SrtStats;
        // Setters
        this.set_cmd = this._set_cmd;
        this.get_gst_SrtStats = this._get_gst_SrtStats; // need to map that child class can access function
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashing the whole process when the c++ process crashes)
     * @param {String} cmd - command to exe
     */
    _start_gst(cmd) {
        if (!this._cmd && this.ready && this.run) {
            this.start_cmd(cmd);
            // standard stdout handling
            this.stdoutCallback = (data) => {
                this._parent._log(
                    "INFO",
                    `${this._controlName} (${this.displayName}): ${data}`
                );
            };

            // standard stderr handling
            this.stderrCallback = (data) => {
                this._parent._log(
                    "INFO",
                    `${this._controlName} (${this.displayName}): ${data}`
                );
            };

            // standard stdin handling
            this.stdinCallback = (data) => {
                this._parent._log(
                    "INFO",
                    `${this._controlName} (${this.displayName}): ${data}`
                );
            };

            // standard message handling
            this.messageCallback = (msg, data) => {
                this.emit(msg, data);
            };
        }
    }

    /**
     * Stop spawned node process
     */
    _stop_gst() {
        if (this._cmd) this.stop_cmd();
    }

    /**
     * Get Srt Stats from gstreamer element
     * @param {String} resMessage - Message name for SrtStats
     * @param {String} srtElementName - Srt Element name
     */
    _get_gst_SrtStats(resMessage, srtElementName) {
        this._cmd &&
            this._cmd.send(["GetSrtStats", resMessage, srtElementName]);
    }

    /**
     * Live Changes to GST pipeline
     * @param {String} elementName
     * @param {String} valType (gdouble / int / string / bool)
     * @param {String} key
     * @param {*} value (gdouble, int, string, bool)
     */
    _set_gst(elementName, valType, key, value) {
        this._cmd && this._cmd.send(["Set", elementName, valType, key, value]);
    }
}

module.exports = GstBase;
