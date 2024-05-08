/**
 * Base class for processing base gstreamer functions
*/

const { spawn } = require('child_process');

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
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashink the whole process when the c++ proccess crashes)
     * @param {String} path - path to child process
     * @param {Array} args - List of process arguments to pass
     */
    _start_gst(path, args) {
        if (!this._gst && this.ready && this.run) {
            // clear old stats data
            this._clearStats();
            try {
                let _this = this;

                this._gst = spawn('node', [path, ...args], {cwd: "./", stdio: [null, null, null, 'ipc']} );

                // standard stdout handeling
                this._gst.stdout.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standard stderr handeling
                this._gst.stderr.on('data', (data) => {
                    _this._parent._log('ERROR', `${this._controlName} (${this.displayName}): ${data}`);
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
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Got exit code, restarting in 3s`);
                    this.stop_gst();
                    setTimeout(() => { this.start_gst(path, args) }, 3000);
                });

            }
            catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): opus decoder (gstreamer) error: ${err.message}, restarting in 3s`);
                this.stop_gst();
                setTimeout(() => { this.start_gst(path, args) }, 3000);
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
    }

    /**
     * Get Srt Stats from gstreamer element
     * @param {String} resMessage - Message name for SrtStats
     * @param {String} srtElementName - Srt Element name
     */
    _get_gst_SrtStats(resMessage, srtElementName) {
        this._gst && this._gst.send(["GetSrtStats", resMessage, srtElementName]);
    }
}

module.exports = GstBase;