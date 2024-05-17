/**
 * Base class for processing base gstreamer functions
*/

const { spawn } = require('child_process');

/**
 * SrtBase Class, used as a base class for all shared SRT function
 */
class vuMeter {
    constructor() {
        this._gstVU = undefined;
        this.start_vu = this._start_vu;   // need to map that child class can access function
        this.stop_vu = this._stop_vu;     // need to map that child class can access function
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashink the whole process when the c++ proccess crashes)
     * @param {String} path - path to child process
     * @param {Array} args - List of process arguments to pass
     */
    _start_vu(path, args) {
        if (!this._gstVU && this.ready && this.run) {
            try {
                let _this = this;

                this._gstVU = spawn('node', [path, ...args], {cwd: "./", stdio: [null, null, null, 'ipc']} );

                // standard stdout handeling
                this._gstVU.stdout.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standard stderr handeling
                this._gstVU.stderr.on('data', (data) => {
                    _this._parent._log('ERROR', `${this._controlName} (${this.displayName}): ${data}`);
                });
                
                // standard stdin handeling
                this._gstVU.stdin.on('data', (data) => {
                    _this._parent._log('INFO', `${this._controlName} (${this.displayName}): ${data}`);
                });

                // standard message handeling
                this._gstVU.on('message', ([msg, data]) => {
                    this.emit(msg, data);
                });
                
                // Restart pipeline on exit
                this._gstVU.on('exit', (data) => {
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Got exit code, restarting in 3s`);
                    this.stop_vu();
                    setTimeout(() => { this.start_vu(path, args) }, 3000);
                });

            }
            catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}): opus decoder (VU) error: ${err.message}, restarting in 3s`);
                this.stop_vu();
                setTimeout(() => { this.start_vu(path, args) }, 3000);
            }
        }
    }

    /**
     * Stop spawned node process
     */
    _stop_vu() {
        if (this._gstVU) {
            this._gstVU.stdin.pause();
            this._gstVU.kill();
            this._gstVU = undefined;
        }
    }
}

module.exports = vuMeter;