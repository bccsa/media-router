const _paNullSinkBase = require('./_paNullSinkBase');
const { spawn } = require('child_process');

class SrtOpusInput extends _paNullSinkBase {
    constructor() {
        super();

        this._ffmpeg;
        this._gst;
        this._srt;
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 1;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 0;
        this.srtStats = '';         // SRT statistics in JSON string format
        this.SetAccess('srtStats', { Set: 'none' });
    }

    Init() {
        super.Init();

        // Get unique UDP socket port
        this._udpSocketPort = this._parent.GetUdpSocketPort();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                // this._start_srt().then(() => {
                    this._start_gst();
                // });
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                // this._stop_srt();
                this._stop_gst();
            }
        });
    }

    _start_gst() {
        if (!this._gst) {
            try {
                console.log(`${this._controlName} (${this.displayName}): Starting opus decoder (gstreamer)`);

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

                // let args = `srtsrc uri="srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188" ! application/x-rtp,media=audio,clock-rate=48000,encoding-name=OPUS,payload=96 ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! pulsesink device="${this.sink}"`;
                let args = `srtsrc uri="srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}" ! application/x-rtp,media=audio,clock-rate=48000,encoding-name=OPUS,payload=96 ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! queue leaky="upstream" ! pulsesink device="${this.sink}" latency-time=${this._parent.paLatency * 1000}`;

                this._gst = spawn('gst-launch-1.0', args.replace(/\s+/g, ' ').split(" "));

                // Handle stderr
                this._gst.stderr.on('data', data => {
                    console.error(data.toString());
                });

                // Handle stdout
                this._gst.stdout.on('data', data => {
                    console.log(data.toString());
                });

                // Handle process exit event
                this._gst.on('close', code => {
                    if (code != null) { console.log(`${this._controlName} (${this.displayName}): opus decoder (gstreamer) stopped (${code})`) }
                    this._stop_gst();
                });

                // Handle process error events
                this._gst.on('error', code => {
                    console.error(`${this._controlName} (${this.displayName}): opus decoder (gstreamer) error #${code}`);
                });
            }
            catch (err) {
                console.error(`${this._controlName} (${this.displayName}): opus decoder (gstreamer) error ${err.message}`);
                this._stop_gst();
            }
        }
    }

    _stop_gst() {
        if (this._gst) {
            try {
                this._gst.stdin.pause();
                this._gst.kill('SIGTERM');
                // ffmpeg stops on SIGTERM, but does not exit.
                // Send SIGKILL to quit process
                this._gst.kill('SIGKILL');
            } catch {

            } finally {
                this._gst = undefined;
            }
        }
    }

    _start_ffmpeg() {
        if (!this._ffmpeg) {
            try {
                console.log(`${this._controlName} (${this.displayName}): Starting opus decoder (ffmpeg)`);

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

                // Opus sample rate is always 48000. Input is therefore assumed to be 48000
                // See https://stackoverflow.com/questions/71708414/ffmpeg-queue-input-backward-in-time for timebase correction info (audio filter)
                // See https://stackoverflow.com/questions/39497131/ffmpeg-pulseaudio-output-options-device for playing to a PulseAudio device (need to specify a stream name)
                // See https://superuser.com/questions/1162140/how-to-account-for-tempo-difference-with-ffmpeg-realtime-stream-encoding for solving audio latency drift
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -rtbufsize 64 -max_delay 1000 -thread_queue_size 0 \
                -f mpegts -c:a libopus -ac ${this.channels} -flush_packets 1 \
                -i srt://127.0.0.1:${this._udpSocketPort}?pkt_size=188&transtype=live&latency=1&mode=caller&recv_buffer_size=188 \
                -c:a pcm_s${this.bitDepth}le \
                -af asetpts=N/SR/TB,aresample=${this.sampleRate},aresample=async=1 \
                -sample_rate ${this.sampleRate} -ac ${this.channels} \
                -buffer_duration ${this._parent.paLatency} -f pulse -device ${this.sink} "${this._paModuleName}"`;
                // -af asetpts=NB_CONSUMED_SAMPLES/SR/TB filter removed - if it should be added again, use a filter complex (only last -af filter is used by ffmpeg)

                // Direct SRT connection:
                // srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188
                // Connection to srt-live-transmit:
                // srt://127.0.0.1:${this._udpSocketPort}?pkt_size=188&transtype=live&latency=1&mode=listener

                this._ffmpeg = spawn('ffmpeg', args.replace(/\s+/g, ' ').split(" "));
                // this._ffmpeg = spawn(args, { shell: 'bash'});

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // console.error(data.toString());
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    console.log(data.toString());
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { console.log(`${this._controlName} (${this.displayName}): opus decoder (ffmpeg) stopped (${code})`) }
                    this._stop_ffmpeg();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    console.log(`${this._controlName} (${this.displayName}): opus decoder (ffmpeg) error #${code}`);
                });
            }
            catch (err) {
                console.log(`${this._controlName} (${this.displayName}): opus decoder (ffmpeg) error ${err.message}`);
                this._stop_ffmpeg();
            }
        }
    }

    _stop_ffmpeg() {
        if (this._ffmpeg) {
            try {
                this._ffmpeg.stdin.pause();
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
        return new Promise((resolve, reject) => {
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

                    if (this.srtMode == 'listener') {
                        this.srtHost = "0.0.0.0"
                    }

                    console.log(`${this._controlName} (${this.displayName}): Starting SRT...`);

                    let args = `-chunk 188 -s 1000 -pf json srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188 srt://0.0.0.0:${this._udpSocketPort}?pkt_size=188&mode=listener&latency=1`;
                    this._srt = spawn('srt-live-transmit', args.split(' '));

                    // Handle stderr
                    this._srt.stderr.on('data', data => {
                        console.error(`${this._paModuleName} (${this.displayName}): SRT - ` + data.toString().trim());
                    });

                    // Handle stdout
                    this._srt.stdout.on('data', data => {
                        this.srtStats = data.toString();
                    });

                    // Handle process exit event
                    this._srt.on('close', code => {
                        if (code != null) { console.log(`${this._controlName} (${this.displayName}): SRT stopped (${code})`) }
                    });

                    // Handle process error events
                    this._srt.on('error', code => {
                        console.log(`Error "${code}"`);
                        reject();
                    });

                    // Resolve if process spawned succesfully (spawn event only available in nodejs v14.17 / V15.1 or newer)
                    // this._srt.on('spawn', () => {
                    //     resolve();
                    // });
                    // Resolve after 500ms
                    setTimeout(() => {
                        resolve();
                    }, 500);
                }
                catch (err) {
                    console.log(`${err.message}`);
                    this._stop_srt();
                    reject();
                }
            } else {
                resolve();
            }
        });
    }

    _stop_srt() {
        if (this._srt) {
            console.log(`${this._controlName} (${this.displayName}): Stopping SRT...`);

            try {
                this._srt.stdin.pause();
                this._srt.kill('SIGTERM');
                this._srt.kill('SIGKILL');
            } catch { }
        }
        this._srt = undefined;
    }
}

module.exports = SrtOpusInput;