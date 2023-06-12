const _paPipeSinkBase = require('./_paPipeSinkBase');
const { spawn } = require('child_process');
const { pcm_buffer } = require('../modules/pcm_buffer');
const { pcm_pipe_in } = require('../modules/pcm_pipe_in');

class OpusOutput extends _paPipeSinkBase {
    constructor() {
        super();

        this.fec = true;            // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this._ffmpeg;
        this._srt;
        this._buffer;
        this._pipe;                 // named pipe output stream produced by the PulseAudio pipe-sink
        this.bufferSize = 1024;     // PCM buffer size in bytes
        this.srtHost = '127.0.0.1';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 200;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 2346;
    }

    Init() {
        super.Init();

        // Start external processes when the underlying pipe-sink is ready (from extended class)
        this.on('pipe-sink-ready', () => {
            // this._start_srt();
            this._pipe = new pcm_pipe_in(this._pipename, this.channels, this.bitDepth, this.bufferSize);
            this._start_ffmpeg();
            // this._start_pipe();
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (run) {
                this._buffer = new pcm_buffer(this.channels, this.bitDepth, this.bufferSize);
            }
            else {
                // this._stop_srt();
                this._stop_ffmpeg();
                // this._stop_pipe();
            }
        })
    }

    _start_ffmpeg() {
        if (!this._ffmpeg) {
            try {
                // Opus sample rate is always 48000. Input sample rate is therefore converted to 48000
                // See https://stackoverflow.com/questions/71708414/ffmpeg-queue-input-backward-in-time for timebase correction info (audio filter)
                console.log(`${this._controlName}: Starting opus encoder (ffmpeg)`);
                // let args = `-y -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay \
                // -f pulse -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -i ${this.source} -af asetpts=NB_CONSUMED_SAMPLES/SR/TB \
                // -c:a libopus -sample_rate 48000 -b:a 64000 -ac ${this.channels} -packet_loss ${this.fecPacketLoss} -fec ${this._fec} \
                // -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                // -f mpegts -`
                let _fec = 0;
                if (this.fec) _fec = 1;

                // let args = `-y -re -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay \
                // -f s${this.bitDepth}le -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -thread_queue_size 16 -i ${this._pipename} \
                // -af asetpts=NB_CONSUMED_SAMPLES/SR/TB \
                // -c:a libopus -sample_rate 48000 -b:a 64000 -ac ${this.channels} -packet_loss ${this.fecPacketLoss} -fec ${_fec} \
                // -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                // -f mpegts udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&buffer_size=2048`;

                // let args = `cat ${this._pipename} | ffmpeg -y -re -hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay \
                // -f s${this.bitDepth}le -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -ac ${this.channels} -i - \
                // -af asetpts=NB_CONSUMED_SAMPLES/SR/TB \
                // -c:a libopus -sample_rate 48000 -b:a 64000 -ac ${this.channels} -packet_loss ${this.fecPacketLoss} -fec ${_fec} \
                // -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                // -f mpegts udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&buffer_size=2048`;


                let args = `pacat -p --device=alsa_output.usb-Solid_State_Logic_SSL_2-00.analog-stereo --rate=${this.sampleRate} --channels=${this.channels} --format=s${this.bitDepth}le --raw`

                // this._ffmpeg = spawn(args, { shell: 'bash' });
                // this._ffmpeg = spawn('ffmpeg', args.replace(/\s+/g, ' ').split(" "));
                this._ffmpeg = spawn(args, { shell: 'bash' });

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // console.log(data.toString())
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
                    console.log(`${this._controlName}: opus encoder (ffmpeg) error #${code}`);
                });

                // pipe from named pipe
                if (this._pipe) {
                    this._pipe.pipe(this._ffmpeg.stdin);
                } else {
                    console.log(`${this._controlName}: Unable to connect opus encoder to PCM buffer: buffer not ready`);
                }
            }
            catch (err) {
                console.log(`${this._controlName}: opus encoder (ffmpeg) error ${err.message}`);
                this._stop_ffmpeg();
            }
        }
    }

    _stop_ffmpeg() {
        if (this._ffmpeg) {
            console.log(`${this._controlName}: Removing opus encoder`);
            try {
                this._pipe.unpipe(this._ffmpeg.stdin);
            } catch {}

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

    _start_pipe() {
        if (!this._pipe) {
            try {
                console.log(`${this._controlName}: Connecting PulseAudio pipe-source...`);

                let args = `${this._pipename}`
                this._pipe = spawn('cat', args.replace(/\s+/g, ' ').split(" "));

                // Handle stderr
                this._pipe.stderr.on('data', data => {
                    // console.log(data.toString())
                });

                // Handle process exit event
                this._pipe.on('close', code => {
                    if (code != null) { console.log(`${this._controlName}: PulseAudio pipe-source disconnected (${code})`) }
                    this._stop_pipe();
                });

                // Handle process error events
                this._pipe.on('error', code => {
                    console.log(`${this._controlName}: PulseAudio pipe-source error #${code}`);
                });

                // pipe to buffer
                if (this._buffer) {
                    this._pipe.stdout.pipe(this._buffer);
                } else {
                    console.log(`${this._controlName}: Unable to connect PulseAudio pipe-source to PCM buffer: buffer not ready`);
                }
                
            }
            catch (err) {
                console.log(`${this._controlName}: PulseAudio pipe-source error ${err.message}`);
                this._stop_pipe();
            }
        }
    }

    _stop_pipe() {
        if (this._pipe) {
            console.log(`${this._controlName}: Disconnecting PulseAudio pipe-source`);
            try {
                this._pipe.stdout.unpipe(this._buffer);
            } catch {}

            try {
                this._pipe.kill('SIGTERM');
                this._pipe.kill('SIGKILL');
            } catch {

            } finally {
                this._pipe = undefined;
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

                let args = `file://con srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}`;
                this._srt = spawn('srt-live-transmit', args.split(' '));

                // Handle stdout
                this._srt.stdout.on('data', data => {
                    console.log(data.toString().trim());
                });

                // Pipe data to srt-live-transmit
                this._pipe.pipe(this._srt.stdin);

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
                // this._pipe.unpipe(this._srt.stdin);
            } catch { }

            try {
                this._srt.kill('SIGTERM');
            } catch { }
        }
        this._srt = undefined;
    }
}

module.exports = OpusOutput;