// ======================================
// Pulse-Code Modulation audio mixer
// via ffmpeg
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const ffmpeg = require('fluent-ffmpeg');
const { StreamInput, StreamOutput } = require('fluent-ffmpeg-multistream');
const { _inputDevice } = require('./_inputDevice');

// -------------------------------------
// Class declaration
// -------------------------------------

class AudioMixer extends _inputDevice {
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
            try {
                this._ffmpeg = ffmpeg();

                // Add inputs to ffmpeg process
                this._inputs.forEach(input => {
                    this._ffmpeg
                        .input(StreamInput(input.stdin).url)        // fluent-ffmpeg does not allow more than one stream input. Using fluent-ffmpeg-multistream to enable using Unix domain sockets
                        .inputOption([
                            '-hide_banner',
                            '-probesize 32',
                            '-analyzeduration 0',
                            '-fflags nobuffer',
                            '-flags low_delay',
                            '-thread_queue_size 512',
                            `-f s${input.bitDepth}le`,
                            `-ac ${input.channels}`,
                            `-sample_rate ${input.sampleRate}`,
                            `-c:a pcm_s${input.bitDepth}le`
                        ]);
                });

                // Specify output format
                this._ffmpeg
                    .addOption(['-hide_banner'])
                    .complexFilter(`amix=inputs=${this._inputs.length}`)
                    .outputFormat(`s${this.bitDepth}le`)
                    .audioChannels(this.channels)
                    .audioFrequency(this.sampleRate)
                    .audioCodec(`pcm_s${this.bitDepth}le`);
    
                // Handle stderr
                this._ffmpeg.on('stderr', (data) => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('end', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);
                });

                // Handle process error events
                this._ffmpeg.on('error', error => {
                    this.isRunning = false;
                    if (!error.message.includes('ffmpeg was killed with signal SIGKILL')) {
                        this._logEvent(error.message);
                    }
                });

                // Start ffmpeg
                this._logEvent('Starting ffmpeg...');
                this.stdout = this._ffmpeg.pipe();
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
            this.isRunning = false;
            this._logEvent(`Stopping ffmpeg...`);
            this._ffmpeg.kill();
            this._ffmpeg = undefined;
        }
    }
}

// Export class
module.exports.AudioMixer = AudioMixer;