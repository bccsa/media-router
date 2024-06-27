/**
 * Base class for processing base gstreamer functions
*/

const { spawn } = require('child_process');
const psTree = require('ps-tree');

/**
 * SrtBase Class, used as a base class for all shared SRT function
 */
class GstBase {
    constructor() {
        this._gst = undefined;
        this.gstMessage = "";
        this.gstMessageData = undefined; 
        this.start_gst = this._start_gst;   // need to map that child class can access function
        this.stop_gst = this._stop_gst;     // need to map that child class can access function
        this.get_gst_SrtStats = this._get_gst_SrtStats;
        // Setters
        this.set_gst = this._set_gst;
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashink the whole process when the c++ proccess crashes)
     * @param {String} cmd - command to exe
     */
    _start_gst(cmd) {
        if (!this._gst && this.ready && this.run) {
            try {
                let _this = this;

                this._gst = spawn('/bin/sh', ['-c', cmd], {cwd: "./", stdio: [null, null, null, 'ipc']} );

                // standard stdout handeling
                this._gst.stdout.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standard stderr handeling
                this._gst.stderr.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standard stdin handeling
                this._gst.stdin.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });

                // standard message handeling
                this._gst.on('message', ([msg, data]) => {
                    this.emit(msg, data);
                });
                
                // Restart pipeline on exit
                this._gst.on('exit', (data) => {
                    this.stop_gst();
                    if (this.ready) {
                        this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Got exit code, restarting in 3s`);
                        setTimeout(() => { this.start_gst(cmd) }, 3000);
                    }
                });

            }
            catch (err) {
                this.stop_gst();
                if (this.ready) {
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): (gstreamer) error: ${err.message}, restarting in 3s`);
                    setTimeout(() => { this.start_gst(cmd) }, 3000);
                }
            }
        }
    }

    /**
     * Stop spawned node process
     */
    _stop_gst() {
        if (this._gst) {
            this._gst.stdin.pause();
            let _this = this;
            let pid = this._gst.pid;
            psTree(pid, function (err, children) { // Solution found here: https://stackoverflow.com/questions/18694684/spawn-and-kill-a-process-in-node-js
                [pid].concat(
                    children.map(function (p) {
                        return p.PID;
                    })
                ).forEach((tpid) => {
                    try { process.kill(tpid, "SIGKILL") }
                    catch (ex) { _this._parent._log('FATAL', `${_this._controlName} (${_this.displayName}): ${ex.message}`) }
                });
            });
            this._gst = undefined;
        }
    }

    /**
     * Get Srt Stats from gstreamer element
     * @param {String} resMessage - Message name for SrtStats
     * @param {String} srtElementName - Srt Element name
     */
    _get_gst_SrtStats(resMessage, srtElementName) {
        this._gst && this._gst.send(["GetSrtStats", resMessage, srtElementName]);
    }

    /**
     * Live Changes to GST pipeline
     * @param {String} elementName 
     * @param {String} valType (gdouble / int / string / bool)
     * @param {String} key 
     * @param {*} value (gdouble, int, string, bool)
     */
    _set_gst(elementName, valType, key, value) {
        this._gst && this._gst.send(["Set", elementName, valType, key, value]);
    }
}

module.exports = GstBase;