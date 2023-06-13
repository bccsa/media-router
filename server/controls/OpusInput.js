const _paPipeSourceBase = require('./_paPipeSourceBase');
const { spawn } = require('child_process');

class OpusInput extends _paPipeSourceBase {
    constructor() {
        super();

        this.fec = true;            // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this._ffmpeg;
        this._srt;
        this.srtHost = '127.0.0.1';
        this.srtPort = 1234;
        this.srtMode = 'listener';
        this.srtLatency = 10;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 2347;
        this.udpBufferSize = 2048;  // Buffer size of 2048 needed for stable stream to srt-live-transmit
        this.srtStats = '';         // SRT statistics in JSON string format
    }

    Init() {
        super.Init();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('pipe-source-ready', () => {
            this._start_ffmpeg();
            this._start_srt();
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                this._stop_ffmpeg();
                this._stop_srt();
            }
        })
    }

    _start_ffmpeg() {
        if (!this._ffmpeg) {
            try {
                console.log(`${this._controlName}: Starting opus decoder (ffmpeg)`);

                let _fec = 0;
                if (this.fec) _fec = 1;

                // Opus sample rate is always 48000. Input is therefore assumed to be 48000
                // See https://stackoverflow.com/questions/71708414/ffmpeg-queue-input-backward-in-time for timebase correction info (audio filter)
                // Connecting with a UDP socket seems to be the best solution. Piping directly to srt-live-transmit gave very unstable / choppy audio.
                let args = `-y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay \
                -f mpegts -c:a libopus -ac ${this.channels} \
                -i udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&buffer_size=${this.udpBufferSize} \
                -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -af aresample=${this.sampleRate} -c:a pcm_s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} \
                -f s${this.bitDepth}le ${this._pipename}`;

                this._ffmpeg = spawn('ffmpeg', args.replace(/\s+/g, ' ').split(" "));

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // console.log(data.toString())
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    console.log(data.toString());
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { console.log(`${this._controlName}: opus decoder (ffmpeg) stopped (${code})`) }
                    this._stop_ffmpeg();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    console.log(`${this._controlName}: opus decoder (ffmpeg) error #${code}`);
                });
            }
            catch (err) {
                console.log(`${this._controlName}: opus decoder (ffmpeg) error ${err.message}`);
                this._stop_ffmpeg();
            }
        }
    }

    _stop_ffmpeg() {
        if (this._ffmpeg) {
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
    }

    _start_srt() {
        if (!this._srt) {
            try {
                // SRT external process
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

                let args = `-chunk 188 -s 1000 -pf json srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188 udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&sndbuf=${this.udpBufferSize}`;
                this._srt = spawn('srt-live-transmit', args.split(' '));

                // Handle stderr
                this._srt.stderr.on('data', data => {
                    console.error(data.toString().trim());
                });

                // Handle stderr
                this._srt.stdout.on('data', data => {
                    this.srtStats = data.toString();
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
                this._srt.kill('SIGTERM');
            } catch { }
        }
        this._srt = undefined;
    }
}

module.exports = OpusInput;