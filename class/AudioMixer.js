// ======================================
// Pulse-Code Modulation audio mixer
// via ffmpeg
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const { spawn } = require('child_process');
const { StreamInput, StreamOutput } = require('fluent-ffmpeg-multistream');
const { _audioInputDevice } = require('./_audioInputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioMixer extends _audioInputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Audio Mixer'; 
        this._ffmpeg = undefined;
        this._inputs = [];
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            this._logEvent('Starting ffmpeg...');
            try {
                let args = `-hide_banner `;

                // Add inputs
                this._inputs.forEach(input => {
                    args += `-f s${input.bitDepth}le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -sample_rate ${input.sampleRate} -ac ${input.channels} -c:a pcm_s${input.bitDepth}le -i ${StreamInput(input.stdout).url} `;
                    //args += `-f s${input.bitDepth}le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -thread_queue_size 512 -ac ${input.channels} -sample_rate ${input.sampleRate} -c:a pcm_s${input.bitDepth}le -i ${StreamInput(input.stdout).url} `;
                });

                // Add filters to ffmpeg command.
                args += `-filter_complex amix=inputs=${this._inputs.length} `;

                // Add audio output (stdout)
                args += `-f s${this.bitDepth}le -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -`;

                // Start ffmpeg
                this._ffmpeg = spawn('ffmpeg', args.split(' '));
                this.stdout = this._ffmpeg.stdout;
    
                // Handle stderr
                this._ffmpeg.stderr.on('data', (data) => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this.isRunning = false;
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);

                    this._ffmpeg = undefined;
                });

                // Handle process error events
                this._ffmpeg.on('error', error => {
                    this.isRunning = false;
                    this._logEvent(error);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
            }
        }
    }

    // Add a mixer input to the mixer
    AddInput(AudioMixerInput) {
        this._inputs.push(AudioMixerInput);
    }

    // Stop the input capture process
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process

        if (this._ffmpeg != undefined) {
            this._logEvent(`Stopping ffmpeg...`);
            this.isRunning = false;
            this._ffmpeg.kill('SIGTERM');
            this._ffmpeg.kill('SIGKILL');
            this._ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.AudioMixer = AudioMixer;