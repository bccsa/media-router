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
// const ffmpeg = require('fluent-ffmpeg');
const { StreamInput, StreamOutput } = require('fluent-ffmpeg-multistream');
const { _inputDevice } = require('./_inputDevice');
const zmq = require('zeromq');


// -------------------------------------
// Class declaration
// -------------------------------------

class AudioMixer extends _inputDevice {
    constructor(DeviceList) {
        super(DeviceList);
        this.name = 'New Audio Mixer'; 
        this._ffmpeg = undefined;
        this._inputs = [];
        //this._azmqPort = this._deviceList.GetTcpPort();
        this._tcpPorts = [];
    }

    // Get unique TCP port for a given input number
    _tcpPort(inputNumber) {
        if (this._tcpPorts.length > inputNumber) {
            // tcp port already aquired
            return this._tcpPorts[inputNumber];
        }
        else {
            // Get new TCP port
            let port = this._deviceList.GetTcpPort();
            this._tcpPorts.push(port);
            return port;
        }
    }

    // Start the input capture process
    Start() {
        this._exitFlag = false;   // Reset the exit flag
        if (this._ffmpeg == undefined) {
            try {
                let args = `-hide_banner `;
                let afilter = ``;       // audio filtergraph
                let amix = '';      // Input pads for amix filter

                // Add inputs
                let i = 0;
                this._inputs.forEach(input => {
                    // ffmpeg input
                    args += `-f s${input.bitDepth}le -probesize 32 -analyzeduration 0 -fflags nobuffer -flags low_delay -thread_queue_size 512 -ac ${input.channels} -sample_rate ${input.sampleRate} -c:a pcm_s${input.bitDepth}le -i ${StreamInput(input.stdin).url} `

                    let azmqPort = this._tcpPort(i);

                    // Add input to audio filter
                    afilter += `[${i}:a]volume@remote${i},azmq=bind_address='tcp\\\://127.0.0.1\\\:${azmqPort}'[a${i}];`;
                    amix += `[a${i}]`;
                    i++;
                });

                // Add mixer to audio filter. Important to enclose the azmq bind address in '', otherwise ffmpeg complains
                afilter += `${amix}amix=inputs=${i}'`;

                // Add filters to ffmpeg command.
                args += `-filter_complex ${afilter} `;

                // Add audio output (stdout)
                args += `-c:a pcm_s${this.bitDepth}le -ac ${this.channels} -sample_rate ${this.sampleRate} -f s${this.bitDepth}le -`;

                // Start ffmpeg
                this._ffmpeg = spawn('ffmpeg', args.split(' '));
                this.stdout = this._ffmpeg.stdout;
    
                // Handle stderr
                this._ffmpeg.stderr.on('data', (data) => {
                    this._logEvent(`${data.toString()}`);
                });

                // Handle process exit event
                this._ffmpeg.on('close', code => {
                    this.isRunning = false;
                    this._logEvent(`Closed (${code})`);

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

                // To test: https://github.com/reneraab/pcm-volume/blob/master/index.js
                // http://www.astro-electronic.de/FFmpeg_Book.pdf page 218
                setTimeout(() => {
                    let sock = zmq.socket('push');
                    sock.connect(`tcp://127.0.0.1:${this._tcpPorts[0]}`);
                    //sock.send('Parsed_volume_0 volume 0.0');
                    sock.send("volume@remote0 volume 0.0");
                    //sock.send('Parsed_volume_2 volume 0.0');
                    sock.disconnect(`tcp://127.0.0.1:${this._tcpPorts[0]}`);
                }, 5000);
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