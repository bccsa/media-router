// ======================================
// SRT Opus input via ffmpeg, encoded to PCM
//
// Copyright BCC South Africa
// =====================================

const { spawn } = require('child_process');
const { _audioInputDevice } = require('./_audioInputDevice');
const fs = require('fs');

/** SRT Opus audio input */
class SrtOpusInput extends _audioInputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        /** Display name */
        this.name = 'New SRT Opus Input';
        /** Audio sample rate */
        this.sampleRate = 48000;
        /** Audio bit depth */
        this.bitDepth = 16;
        /** Audio channel count */
        this.channels = 1;
        /** SRT host name / ip address */
        this.srtHost = 'srt.invalid';
        /** SRT port */
        this.srtPort = 5000;
        /** SRT mode (caller, listener, rendevouz) */
        this.srtMode = 'caller';
        /** SRT encryption key length */
        this.srtPbKeyLen = 16;
        /** SRT encryption passphrase */
        this.srtPassphrase = '';
        /** SRT latency */
        this.srtLatency = 200;
        /** SRT max bandwidth in byte per second */
        this.srtMaxBw = 8000;
        /** SRT Stream ID */
        this.srtStreamID = ''
        this._srt = undefined;
        this._ffmpeg = undefined;

        // Subscribe to DeviceList start and stop events
        DeviceList.run.on('start', () => {
            this.Start();
        });

        DeviceList.run.on('stop', () => {
            this.Stop();
        });
    }

    /** Start the external processes */
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        this._start_ffmpeg();
    }

    _start_ffmpeg() {
        if (this._ffmpeg == undefined) {
            try {
                let crypto = "";
                if (this.srtPassphrase != '') {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`
                }
                this._logEvent(`Starting ffmpeg...`);
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f mpegts -c:a libopus -i "srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}&maxbw=${this.srtMaxBw}&streamid=${this.srtStreamID}${crypto}" -af aresample=async=1000 -c:a pcm_s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -f s${this.bitDepth}le -`
                this._ffmpeg = spawn('ffmpeg', args.split(" "), { shell: "bash" });
                this._ffmpeg.stdout.pipe(this.stdout);

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    if (!this._exitFlag) {
                        setTimeout(() => {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }, 1000);
                    }

                    this.Stop();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error "${code}"`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this._logEvent(`${err.message}`);
                this.Stop();
            }
        }
    }

    // Stop the input capture process
    Stop() {
        try {
            this._exitFlag = true;   // prevent automatic restarting of the process
            this.isRunning = false;
            if (this._ffmpeg) {
                this._ffmpeg.stdout.unpipe(this.stdout);
                this._logEvent(`Stopping ffmpeg: ${this.name} ...`);
                this._ffmpeg.kill('SIGTERM');

                // ffmpeg stops on SIGTERM, but does not exit.
                // Send SIGKILL to quit process
                this._ffmpeg.kill('SIGKILL');
                this._ffmpeg = undefined;
            }
        }
        catch (err) {
            this._logEvent(err.message);
        }
    }
}

// Export class
module.exports.SrtOpusInput = SrtOpusInput;