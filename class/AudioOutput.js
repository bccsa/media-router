// ======================================
// Hardware Pulse-Code Modulation output
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { _outputAudioDevice } = require('./_outputAudioDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioOutput extends _outputAudioDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Alsa Output';      // Display name
        // this.format = 'S16_LE';             // For valid formats, see _ffmpeg
        this.sampleRate = 48000;            // PCM sample rate
        this.bitDepth = 16;
        this.channels = 1;                  // Channel count
        this.device = 'default';              // Device name - see _ffmpeg -L
        // this.buffer = 50000;                // Buffer in microseconds         // stdin mapped to _ffmpeg process stdin
        this._ffmpeg = undefined;            // ffmpeg process
    }

    // Start the playback process
    Start() {
        this._logEvent('Starting aplay...')
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f s${this.bitDepth}le -thread_queue_size 512 -ac ${this.channels} -sample_rate ${this.sampleRate} -i - -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -f alsa ${this.device}`;
                // let args = `--nonblock -D ${this.device} -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 1024 --period-size 512 -`;
                // let args = `--nonblock -D plughw:CARD=${this.alsaDevice},DEV=0 -c ${this.channels} -r ${this.sampleRate} -f ${this.format} -B ${this.buffer} --buffer-size 1024 --period-size 512 -`;
                this._ffmpeg = spawn('ffmpeg', args.split(" "));
                this.stdin = this._ffmpeg.stdin;
    
                // Handle stderr
                this._ffmpeg.stderr.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting aplay...`);
                            this.Start();
                        }
                    }, 1000);

                    this._ffmpeg = undefined;
                });

                // Handle process error events
                this._ffmpeg.on('error', error => {
                    this.isRunning = false;
                    this._logEvent(`${error}`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    // Stop the playback process
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._ffmpeg != undefined) {
            this.isRunning = false;
            this._logEvent(`Stopping aplay...`);
            this._ffmpeg.kill('SIGTERM');

            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');
        }
    }
}

// Export class
module.exports.AudioOutput = AudioOutput;