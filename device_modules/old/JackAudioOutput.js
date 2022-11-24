// ======================================
// Hardware JACK Pulse-Code Modulation output
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _audioOutputDevice } = require('./_audioOutputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

/**
 * PCM stdin to Jack Audio Output port
 * @extends _audioOutputDevice
 * @property {string} ports - Space delimted list of JACK input ports (run jack_lsp for list of ports) (default = system:playback_1 system:playback_2)
 * @property {string} bufferSize - Buffer size in (default = 256k)
 * @property {string} encoding - Audio encoding format [signed, unsigned, float] (default = signed)
 */
class JackAudioOutput extends _audioOutputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.ports = 'system:playback_1 system:playback_2';
        this._process = undefined;
        this.bufferSize = '256k';
        this.sampleRate = undefined;
        this.encoding = 'signed';
    }

    // Start the playback process
    Start() {
        this._logEvent('Starting jack-stdin...')
        this._exitFlag = false;   // Reset the exit flag
        if (this._process == undefined) {
            try {
                let args = `-S ${this.bufferSize} -b ${this.bitDepth} -e ${this.encoding} ${this.ports}`;
                
                // Wait for jack server to run
                setTimeout(() => {
                    this._process = spawn('jack-stdin', args.split(" "));
                    this.stdin.pipe(this._process.stdin);
        
                    // Handle stderr
                    this._process.stderr.on('data', (data) => {
                        this._logEvent(`${data.toString()}`);
                    });
    
                    this._process.on('exit', code => {
                        this._logEvent(`Exit`)
                    });
    
                    // Handle stdout
                    this._process.stdout.on('data', (data) => {
                        this._logEvent(`${data.toString()}`);
                    });
    
                    // Handle process exit event
                    this._process.on('close', code => {
                        if (this._process) {
                            this.stdin.unpipe(this._process.stdin);
                            this._process.kill('SIGTERM');
                            this._process.kill('SIGKILL');
                            this._process = undefined;
                        }
    
                        this.isRunning = false;
                        if (code != null) { this._logEvent(`Closed (${code})`) }
    
                        // Restart after 1 second
                        setTimeout(() => {
                            if (!this._exitFlag) {
                                this._logEvent(`Restarting jack-stdin...`);
                                this.Start();
                            }
                        }, 1000);
                    });
    
                    // Handle process error events
                    this._process.on('error', error => {
                        this.isRunning = false;
                        this._logEvent(`${error}`);
                    });
    
                    this.isRunning = true;
                }, 1000);
                
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    // Stop the playback process
    Stop() {
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process

            if (this._process) {
                this.stdin.unpipe(this._process.stdin);
                this.isRunning = false;
                this._logEvent(`Stopping jack-stdin...`);
                this._process.kill('SIGTERM');
    
                // Send SIGKILL to quit process
                this._process.kill('SIGKILL');
            }
        }
        catch (error) {
            this._logEvent(error.message);
        }
        
    }
}

// Export class
module.exports.JackAudioOutput = JackAudioOutput;