const _paNullSinkBase = require('./_paNullSinkBase');
const { spawn } = require('child_process');
const { ffmpeg_stderr_parser } = require('../modules/ffmpeg_stderr_parser');

class SrtOpusOutput extends _paNullSinkBase {
    constructor() {
        super();

        this.fec = false;           // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this.compression = 10;      // Opus compression level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.bitrate = 64;          // Opus encoding target bitrate in kbps
        this._ffmpeg;
        this._srt;
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtLatency = 1;
        this.srtStreamID = '';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this._udpSocketPort = 0;
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
                this._start_srt().then(() => {
                    this._start_ffmpeg();
                });
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                this._stop_ffmpeg();
                this._stop_srt();
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
                console.log(`${this._controlName} (${this.displayName}): Starting opus encoder (ffmpeg)`);

                let _fec = 0;
                if (this.fec) _fec = 1;

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

                // Opus sample rate is always 48000. Input sample rate is therefore converted to 48000
                // See https://stackoverflow.com/questions/71708414/ffmpeg-queue-input-backward-in-time for timebase correction info (audio filter)
                // See https://superuser.com/questions/1162140/how-to-account-for-tempo-difference-with-ffmpeg-realtime-stream-encoding for solving audio latency drift
                let args = `-hide_banner -probesize 32 -analyzeduration 0 -flush_packets 1 -thread_queue_size 0 \
                -fflags nobuffer -flags low_delay -rtbufsize 64 -max_delay 1000 \
                -channels ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -f pulse -i ${this.source} \
                -af asetpts=N/SR/TB,aresample=48000,aresample=async=1 \
                -c:a libopus -b:a ${this.bitrate * 1000} -application lowdelay -sample_rate 48000 -ac ${this.channels} -packet_loss ${this.fecPacketLoss} -fec ${_fec} -compression_level ${this.compression} \
                -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                -f mpegts  -flush_packets 1 -omit_video_pes_length 0 srt://127.0.0.1:${this._udpSocketPort}?pkt_size=188&transtype=live&latency=1&mode=caller`;

                // Direct srt connection
                // srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188

                // connection to srt-live-transmit
                // srt://127.0.0.1:${this._udpSocketPort}?pkt_size=188&transtype=live&latency=1&mode=caller&sndbuf=16384
                
                // let args = `pacat --record --device ${this.source} --format s${this.bitDepth}le --channels ${this.channels} --rate ${this.sampleRate} --latency-msec 1 --format s${this.bitDepth}le --raw | \
                // ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -flush_packets 1 \
                // -fflags nobuffer -flags low_delay \
                // -channels ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -fragment_size ${fragSize} -f s${this.bitDepth}le -i - \
                // -af asetpts=NB_CONSUMED_SAMPLES/SR/TB \
                // -c:a libopus -sample_rate 48000 -ac ${this.channels} -packet_loss ${this.fecPacketLoss} -fec ${_fec} -compression_level ${this.compression} \
                // -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                // -f mpegts srt://127.0.0.1:${this._udpSocketPort}?pkt_size=188&transtype=live&latency=1&mode=caller`;

                // let args = `parec --device ${this.source} --fix-format --fix-channels --fix-rate --latency-msec 1 --format s${this.bitDepth}le --raw | \
                // ffmpeg -hide_banner -probesize 32 -analyzeduration 0 -flush_packets 1 -fflags nobuffer -flags low_delay \
                // -channels ${this.channels} -sample_rate ${this.sampleRate} -c:a pcm_s${this.bitDepth}le -i - \
                // -af asetpts=NB_CONSUMED_SAMPLES/SR/TB -c:a libopus -sample_rate 48000 -ac ${this.channels} \
                // -packet_loss ${this.fecPacketLoss} -fec ${_fec} -compression_level ${this.compression} -b:a ${this.bitrate} \
                // -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct \
                // -f mpegts udp://127.0.0.1:${this._udpSocketPort}?pkt_size=188&buffer_size=${this.udpBufferSize}`;

                this._ffmpeg = spawn('ffmpeg', args.replace(/\s+/g, ' ').split(" "));
                // this._ffmpeg = spawn(args, { shell: 'bash' });

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // console.error(data.toString());
                    this._ffmpegParser.Set(data.toString());
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    // console.log(data.toString());
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { console.log(`${this._controlName} (${this.displayName}): opus encoder (ffmpeg) stopped (${code})`) }
                    this._stop_ffmpeg();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    console.error(`${this._controlName} (${this.displayName}): opus encoder (ffmpeg) error #${code}`);
                });
            }
            catch (err) {
                console.error(`${this._controlName} (${this.displayName}): opus encoder (ffmpeg) error ${err.message}`);
                this._stop_ffmpeg();
            }
        }
    }

    _stop_ffmpeg() {
        if (this._ffmpeg) {
            console.log(`${this._controlName} (${this.displayName}): Removing opus encoder`);
            try {
                this._ffmpeg.stdin.pause();
                this._ffmpeg.kill('SIGTERM');
                // ffmpeg stops on SIGTERM, but does not exit.
                // Send SIGKILL to quit process
                this._ffmpeg.kill('SIGKILL');
            } catch {
                console.log('failed to stop ffmpeg')
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
    
                    console.log(`${this._controlName} (${this.displayName}): Starting SRT...`);
    
                    let args = `-s 1000 -pf json srt://127.0.0.1:${this._udpSocketPort}?mode=listener&latency=1 srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}${latency}${streamID}${crypto}&payloadsize=188`;
                    this._srt = spawn('srt-live-transmit', args.split(' '));
    
                    // Handle stdout
                    this._srt.stdout.on('data', data => {
                        this.srtStats = data.toString();
                    });
    
                    // Handle stderr
                    this._srt.stderr.on('data', data => {
                        console.error(`${this._controlName} (${this.displayName}): SRT - ` + data.toString().trim());
                    });
    
                    // Handle process exit event
                    this._srt.on('close', code => {
                        if (code != null) { console.log(`${this._controlName} (${this.displayName}): SRT stopped (${code})`) }
                    });
    
                    // Resolve if process spawned succesfully (spawn event only available in nodejs v14.17 / V15.1 or newer)
                    // this._srt.on('spawn', () => {
                    //     resolve();
                    // });
                    // Resolve after 500ms
                    setTimeout(() => {
                        resolve();
                    }, 500);

                    // Handle process error events
                    this._srt.on('error', code => {
                        console.log(`${this._controlName} (${this.displayName}): SRT error "${code}"`);
                        reject();
                    });
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

module.exports = SrtOpusOutput;