const _paNullSink = require('./_paNullSink');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

class OpusInput extends _paNullSink {
    constructor() {
        super();

        this.fec = true;            // Enable opus Forward Error Correction
        this._fec = 0;              // Internal FEC value
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this._ffmpeg;
        this._pipe = new PassThrough();
        this._srt;
        this.srtHost = '127.0.0.1';
        this.srtPort = 1234;
        this.srtMode = 'listener';
        this.srtLatency = 1000;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
    }

    Init() {
        super.Init();
        this.on('fec', fec => {
            if (fec) {
                this._fec = 1;
            } else {
                this._fec = 0;
            }
        });

        this.on('null-sink', state => {
            if (state) {
                // Start SRT and ffmpeg after the PulseAudio null-sink module is created
                this._start_srt();
                this._start_ffmpeg();
            } else {
                // Stop SRT and ffmpeg before the PulseAudio null-sink module is removed
                this._stop_srt();
                this._stop_ffmpeg();
            }
        });
    }

    _start_ffmpeg() {
        if (!this._ffmpeg) {
            try {
                // Opus sample rate is always 48000. Input is therefore set to 48000
                // See https://stackoverflow.com/questions/71708414/ffmpeg-queue-input-backward-in-time for timebase correction info (audio filter)
                console.log(`${this._controlName}: Starting opus decoder (ffmpeg)`);
                let args = `-y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay \
                -f mpegts -c:a libopus -i - \
                -c:a pcm_s${this.bitdepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} \
                -f pulse ${this.sink}`

                this._ffmpeg = spawn('ffmpeg', args.replace(/\s+/g, ' ').split(" "));

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    console.log(data.toString())
                });

                // Pipe to ffmpeg
                this._pipe.pipe(this._ffmpeg.stdin);

                this._ffmpeg.stdout.on('data', data => {
                    console.log(data.toString());
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { console.log(`${this._controlName}: opus decoder (ffmpeg) stopped (${code})`) }
                    this._kill_ffmpeg();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    console.log(`${this._controlName}: opus decoder (ffmpeg) error #${code}`);
                });
            }
            catch (err) {
                console.log(`${this._controlName}: opus decoder (ffmpeg) error ${err.message}`);
                this._kill_ffmpeg();
            }
        }
    }

    _stop_ffmpeg() {
        if (this._ffmpeg) {
            console.log(`${this._controlName}: Stopping opus decoder (ffmpeg)...`);
            try {
                this._ffmpeg.stdout.unpipe(this._pipe);
            } catch {}
        }
        this._kill_ffmpeg();
    }

    _kill_ffmpeg() {
        try {
            this._ffmpeg.kill('SIGTERM');
            // ffmpeg stops on SIGTERM, but does not exit.
            // Send SIGKILL to quit process
            this._ffmpeg.kill('SIGKILL');
        } catch {
            
        } finally {
            this._ffmpeg = undefined;
        }
    }

    _start_srt() {
        if (!this._srt) {
            try {
                // SRT external process
                `${this._controlName}: Starting SRT...`
                let crypto = '';
                if (this.srtPassphrase) {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`;
                }

                let latency = '';
                if (this.srtMode == 'caller') {
                    latency = '&latency=' + this.srtLatency
                }

                let streamID = '';
                if (this.srtStreamID) {
                    streamID = '&streamid=' + this.srtStreamID;
                }

                console.log(`${this._controlName}: Starting SRT...`);

                let args = `srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto} file://con`;
                this._srt = spawn('srt-live-transmit', args.split(' '));

                // Pipe data from srt-live-transmit
                this._srt.stdout.pipe(this._pipe);

                // Handle stderr
                this._srt.stderr.on('data', data => {
                    console.error(data.toString().trim());
                });

                // Handle process exit event
                this._srt.on('close', code => {
                    if (code != null) { console.log(`${this._controlName}: SRT stopped (${code})`) }
                });

                // Handle process error events
                this._srt.on('error', code => {
                    console.log(`Error "${code}"`);
                });
            }
            catch (err) {
                console.log(`${err.message}`);
                this._stop_srt();
            }
        }
    }

    _stop_srt() {
        if (this._srt) {
            console.log(`${this._controlName}: Stopping SRT...`);
            try {
                this._pipe.unpipe(this._srt.stdin);
            } catch {}

            try {
                this._srt.kill('SIGTERM');
            } catch {}
        }
        this._srt = undefined;
    }
}

module.exports = OpusInput;