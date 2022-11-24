// ======================================
// PCM to Opus transmitted over mpegts through an SRT tunnel.
// Implemented using ffmpeg and srt-live-transmit
// Copyright BCC South Africa
// =====================================

const { spawn } = require('child_process');
const { _audioOutputDevice } = require('./_audioOutputDevice');

/**
 * SRT Opus audio output
 * @extends _audioOutputDevice
 * @property {Number} udpSocketPort - Unique UDP socket port used internally for transfer of data between ffmpeg and srt-live-transmit.
 * @property {String} srtHost - SRT host name / ip address
 * @property {String} srtPort - SRT mode (caller, listener, rendevouz)
 * @property {Number} srtMode - SRT encryption key length (16, 32)
 * @property {Number} srtPbKeyLen - SRT port
 * @property {String} srtPassphrase - SRT encryption passphrase
 * @property {Number} srtLatency - SRT latency in milliseconds
 * @property {String} srtStreamID - SRT Stream ID
 */
class SrtOpusOutput extends _audioOutputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'SRT Opus audio output';   // Display name
        this.udpSocketPort = 5555;
        this.srtHost = 'srt.invalid';
        this.srtPort = 5000;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = 200;
        this.srtStreamID = ''

        // this.srtMaxBw = 8000;                  // maxbw not implemented in SRT output - srt-live-transmit breaks when maxbw parameter is added in output mode
        this._srt = undefined;
        this._ffmpeg = undefined;
    }

    /** Start the external processes */
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        this._start_srt();
        this._start_ffmpeg();
    }

    _start_ffmpeg() {
        if (!this._ffmpeg) {
            try {
                // ffmpeg external process
                // Opus sample rate is always 48000. Input is therefore converted to 48000                                                                                                                                                                                                -frame_duration 2.5 -application lowdelay -compression_level 0 -packet_loss 5 -fec 1                                              
                //let ffmpeg_args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -i - -af aresample=async=1000 -c:a libopus -sample_rate 48000 -ac ${this.channels} -packet_loss 5 -fec 1 -f mpegts udp://127.0.0.1:${this.udpSocketPort}?pkt_size=188&buffer_size=0`
                this._logEvent(`Starting ffmpeg...`);
                let ffmpeg_args = `-hide_banner -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -f s${this.bitDepth}le -sample_rate ${this.sampleRate} -ac ${this.channels} -i - -c:a libopus -sample_rate 48000 -ac ${this.channels} -packet_loss 5 -fec 1 -muxdelay 0 -flush_packets 1 -output_ts_offset 0 -chunk_duration 100 -packetsize 188 -avioflags direct -f mpegts udp://127.0.0.1:${this.udpSocketPort}?pkt_size=188&buffer_size=0`
                this._ffmpeg = spawn('ffmpeg', ffmpeg_args.split(" "));
                this._mixer.pipe(this._ffmpeg.stdin);

                // Handle stderr
                this._ffmpeg.stderr.on('data', data => {
                    // this._logEvent(`${data.toString()}`);
                });

                // Handle stdout
                this._ffmpeg.stdout.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting ffmpeg...`);
                            this.Start();
                        }
                    }, 1000);

                    this.Stop();
                });

                // Handle process error events
                this._ffmpeg.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error "${code}"`);
                });
            }
            catch (err) {
                this._logEvent(`${err.message}`);
                this.Stop()
            }
        }
    }

    _start_srt() {
        if (!this._srt) {
            try {
                // SRT external process
                let crypto = "";
                if (this.srtPassphrase != '') {
                    crypto = `&pbkeylen=${this.srtPbKeyLen}&passphrase=${this.srtPassphrase}`
                }
                this._logEvent(`Starting srt-live-transmit...`);
                let args = `udp://127.0.0.1:${this.udpSocketPort} srt://${this.srtHost}:${this.srtPort}?mode=${this.srtMode}&latency=${this.srtLatency}&streamid=${this.srtStreamID}${crypto}`;
                this._srt = spawn('srt-live-transmit', args.split(" "));

                // Handle stdout
                this._srt.stdout.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle stderr
                this._srt.stderr.on('data', data => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._srt.on('close', code => {
                    if (code != null) { this._logEvent(`Closed (${code})`) }

                    // Restart after 1 second
                    setTimeout(() => {
                        if (!this._exitFlag) {
                            this._logEvent(`Restarting srt-live-transmit...`);
                            this.Start();
                        }
                    }, 1000);

                    this.Stop();
                });

                // Handle process error events
                this._srt.on('error', code => {
                    this.isRunning = false;
                    this._logEvent(`Error "${code}"`);
                });

                this.isRunning = true;
            }
            catch (err) {
                this.isRunning = false;
                this._logEvent(`${err.message}`);
                this.Stop();
            }
        }
    }
    
    /** Stop the external processes */
    Stop() {
        this._exitFlag = true;   // prevent automatic restarting of the process
        this.isRunning = false;
        try {
            if (this._ffmpeg) {
                this.stdin.unpipe(this._ffmpeg.stdin);
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

        try {
            if (this._srt) {
                this._logEvent(`Stopping srt-live-transmit: ${this.name}`);
                this._srt.kill('SIGTERM');
                this._srt = undefined;
            }
        } catch (err) {
            this._logEvent(err.message);
        }
    }
}

// Export class
module.exports.SrtOpusOutput = SrtOpusOutput;