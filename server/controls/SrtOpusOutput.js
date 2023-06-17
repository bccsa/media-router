const _paNullSinkBase = require('./_paNullSinkBase');
const { spawn } = require('child_process');
const { ffmpeg_stderr_parser } = require('../modules/ffmpeg_stderr_parser');
const { read } = require('fs');

class SrtOpusOutput extends _paNullSinkBase {
    constructor() {
        super();

        this.fec = true;            // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this._ffmpeg;
        this._srt;
        this._pipe;                 // named pipe output stream produced by the PulseAudio pipe-sink
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 10;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 0;
        this.ffmpegPulseLatency = 50;
        this.udpBufferSize = 2048;  // Buffer size of 2048 needed for stable stream to srt-live-transmit
        this.outBitrate = 0;        // Opus encoder output bitrate
        this.SetAccess('outBitrate', { Set: 'none' });
        this._ffmpegParser = new ffmpeg_stderr_parser();
        this.srtStats = '';         // SRT statistics in JSON string format
        this.SetAccess('srtStats', { Set: 'none' });
    }

    Init() {
        super.Init();

        // Get unique UDP socket port
        this._udpSocketPort = this._parent.GetUdpSocketPort();

        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                this._start_srt();
                this._start_ffmpeg();
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (run) {

            }
            else {
                this._stop_srt();
                this._stop_ffmpeg();
            }
        });

        // Get opus encoder output bitrate from ffmpeg stderr parser
        this._ffmpegParser.on('bitrate', bitrate => {
            this.outBitrate = bitrate;
        })
    }

    _start_ffmpeg() {
        if (!this._ffmpeg) {
            try {
                console.log(`${this._controlName}: Starting opus encoder (ffmpeg)`);

                let _fec = 0;
                if (this.fec) _fec = 1;

                let fragSize = this.ffmpegPulseLatency / 1000 * this.sampleRate * this.bitDepth / 8 * this.channels;

                // Opus sample rate is always 48000. Input sample rate is therefore converted to 48000
                // See https://stackoverflow.com/questions/71708414/ffmpeg-queue-input-backward-in-time for timebase correction info (audio filter)
                // Connecting with a UDP socket seems to be the best solution. Piping directly to srt-live-transmit gave very unstable / choppy audio.
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -flush_packets 1 \
                -fflags nobuffer -flags low_delay \
                -f pulse -channels ${this.channels} -sample_rate ${this.sampleRate} -fragment_size ${fragSize} -i ${this.source} \
                -af asetpts=NB_CONSUMED_SAMPLES/SR/TB \
                -c:a libopus -sample_rate 48000 -b:a 64000 -ac ${this.channels} -packet_loss ${this.fecPacketLoss} -fec ${_fec} \
                -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                -f mpegts udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&buffer_size=${this.udpBufferSize}`;

                this._ffmpeg = spawn('ffmpeg', args.replace(/\s+/g, ' ').split(" "));

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    this._ffmpegParser.Set(data.toString());
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    // console.log(data.toString());
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { console.log(`${this._controlName}: opus encoder (ffmpeg) stopped (${code})`) }
                    this._stop_ffmpeg();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    console.error(`${this._controlName}: opus encoder (ffmpeg) error #${code}`);
                });
            }
            catch (err) {
                console.error(`${this._controlName}: opus encoder (ffmpeg) error ${err.message}`);
                this._stop_ffmpeg();
            }
        }
    }

    _stop_ffmpeg() {
        if (this._ffmpeg) {
            console.log(`${this._controlName}: Removing opus encoder`);
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

                let args = `-chunk 188 -s 1000 -pf json udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&rcvbuf=${this.udpBufferSize} srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188`;
                this._srt = spawn('srt-live-transmit', args.split(' '));

                // Handle stdout
                this._srt.stdout.on('data', data => {
                    this.srtStats = data.toString();
                });

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
                    console.log(`${this._controlName}: SRT error "${code}"`);
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

module.exports = SrtOpusOutput;