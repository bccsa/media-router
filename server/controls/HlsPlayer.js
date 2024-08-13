const _paNullSinkBase = require('./_paNullSinkBase');
const path = require('path');
const SrtBase = require('./SrtBase');
const { Classes } = require('../modular-dm');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

class HlsPlayer extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
        this.hlsUrl = "";
        this.videoQuality = "";
        this.videoQualities = [];
        this.videoDelay = 0;
        this.sinkspaModuleID = [];
        this.readyNullSinks = 0;
        this.audioStreams = [];
        this._enabledStreams = 0;
        this.defaultLanguage = "";
        this.enableSrt = false;
        this.runningSrt = false;
        this.hlsLoading = false;
        this.startTime = "00:00:00";
        this._vidoeElementName = "videosink";
    }

    Init() {
        super.Init();
        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                // start null sinks
                this._enabledStreams = 0;
                this.readyNullSinks = -1; // Toggle to -1 that the event triggers if there is cuttrntly 0 ready null sinks and none is started
                this.readyNullSinks = 0;
                this.audioStreams.forEach(stream => {
                    if (stream.enabled && stream.language != this.defaultLanguage) {
                        this._enabledStreams++;
                        this._startHlsNullSink(stream.language, stream.comment);
                    }
                })
            }

            // reset hlsLoading
            this.hlsLoading = false;
        });

        this.on('readyNullSinks', c => {
            // isEnabled (Allow pipeline to start if none of the sinks is enabled)
            let isEnabled = false;
            this.audioStreams.forEach(s => {
                if (!isEnabled)
                    isEnabled = s.enabled;
            })
            if ((c > 0 && c == this._enabledStreams) || !isEnabled) {
                // Source
                let lang = "";
                this.audioStreams.forEach(stream => { if (stream.enabled || stream.language == this.defaultLanguage) { lang += stream.language + "," } })
                let streamlink = `streamlink --hls-start-offset ${this.startTime} --player-no-close --hls-audio-select "${lang.slice(0, -1)}" --hls-live-restart "${this.hlsUrl}" ${this.videoQuality} -O`;
                let _pipeline = `filesrc location="/dev/stdin" ! tsdemux name=demux `
                // video
                let videoSink = "";
                if (this.enableSrt) {
                    videoSink = `demux. ! h264parse ! queue flush-on-eos=true ! mpegtsmux alignment=7 name=mux ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! srtserversink name="${this._vidoeElementName}" wait-for-connection=false sync=true ts-offset=${this.videoDelay * 1000000} uri="${this.uri()}"`
                } else {    
                    videoSink = `demux. ! decodebin ! videoconvert ! queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! ` + 
                    `kmssink name=${this._vidoeElementName} ts-offset=${this.videoDelay * 1000000} sync=true `
                }
                _pipeline += videoSink;
                // audio
                this.audioStreams.forEach((stream, i) => {
                    // audio to default sink
                    if (stream.language == this.defaultLanguage) {
                        if (this.enableSrt) { // (Pipe audio to default sink and mux with srt)
                            _pipeline += ` demux. ! ` +
                            `tee name=tee ! ` + 
                            `queue flush-on-eos=true ! ` +
                            `parsebin ! mux. ` + 
                            `tee. ! ` + 
                            `decodebin ! audioconvert ! audio/x-raw,channels=2 ! ` +
                            `queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! ` +
                            `pulsesink name=audioSink ts-offset=${this.videoDelay * 1000000} device=${this.sink} sync=true slave-method=0 processing-deadline=40000000 buffer-time=${this._parent.paLatency * 1000} max-lateness=${this._parent.paLatency * 1000000}`
                        } else {
                            _pipeline += ` demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! ` +
                            `queue max-size-buffers=0 max-size-time=0 max-size-bytes=0 flush-on-eos=true ! ` +
                            `pulsesink name=audioSink ts-offset=${this.videoDelay * 1000000} device=${this.sink} sync=true slave-method=0 processing-deadline=40000000 buffer-time=${this._parent.paLatency * 1000} max-lateness=${this._parent.paLatency * 1000000}`    
                        }
                    } 
                    // audio to null sinks
                    else if (stream.enabled)
                        _pipeline += ` demux. ! decodebin ! audioconvert ! audio/x-raw,channels=2 ! ` +
                        `queue flush-on-eos=true ! ` +
                        `pulsesink device=${this._controlName}_sink_${stream.language} sync=false slave-method=0 processing-deadline=40000000 buffer-time=${this._parent.paLatency * 1000} max-lateness=${this._parent.paLatency * 1000000}`
                })

                // // ------------ start sound processor ------------ //
                if (this.hlsUrl)
                this._parent.PaCmdQueue(() => {
                    if (this.enableSrt) {
                        this.runningSrt = true;
                        this._start_srt(`${streamlink} | node ${path.dirname(process.argv[1])}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`, this._vidoeElementName);
                    } else {
                        this.runningSrt = false;
                        this.start_gst(`${streamlink} | node ${path.dirname(process.argv[1])}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`);
                    }
                });
            }
        })

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                if (this.runningSrt) {this._stop_srt()} else {this.stop_gst()};
                
                while (this.sinkspaModuleID.length > 0) {
                    this._stopHlsNullSink(this.sinkspaModuleID.pop());
                }
            }
        }, { immediate: true });

        this.on('hlsUrl', url => {
            this.hlsLoading = true;
            this.parse_hls(url)
            .then((res) => {
                if (res && Object.keys(res).length > 0) {
                    // remove sources that is not available anymore 
                    let arr = []
                    this.audioStreams.forEach((s, i) => {
                        let c = res.streams.find(c => { if (c.codec_type == "audio" && c.tags.language == s.language) return true });
                        if (c) { // update comment 
                            arr.push(s);
                        } 
                    })

                    this.audioStreams = [];
                    this.videoQualities = [];

                    res.streams.forEach((s, i) => {
                        if (s.codec_type == "audio") {
                            // avoid adding double of the same language
                            if (!this.audioStreams.find(c => { if (c.language == s.tags.language) {return true} })) {
                                let c = arr.find(c => { if (c.language == s.tags.language) return true })
                                if (!c)
                                    this.audioStreams.push({language: s.tags.language, comment: s.tags.comment, index: i, enabled: false});
                                else 
                                    this.audioStreams.push({language: s.tags.language, comment: s.tags.comment, index: i, enabled: c.enabled});
                            }
                        } else if (s.codec_type == 'video' && s.coded_height > 0) {
                            this.videoQualities.push(`${s.height}p`)
                        }
                    })

                    // check if defaultLanguage not exist, then set it to the first sink
                    if (!this.audioStreams.find(c => { if (c.language == this.defaultLanguage) return true }) && this.audioStreams.length > 0)
                        this.defaultLanguage = this.audioStreams[0].language;

                    // check if videoQuality not exist, then set it to the first sink
                    if (!this.videoQualities.find(v => { if (v == this.videoQuality) return true }) && this.videoQualities.length > 0)
                        this.videoQuality = this.videoQualities[this.videoQualities.length -1];

                    this.NotifyProperty('audioStreams');
                    this.NotifyProperty('videoQualities');
                    this.NotifyProperty('defaultLanguage');
                    this.NotifyProperty('videoQuality');
                } 

                this.hlsLoading = false;
            })
        })

        this.on('videoDelay', d => {
            this.set_gst("audioSink", "int", "ts-offset", d);
            this.set_gst(this._vidoeElementName, "int", "ts-offset", d * 1000000);
        })
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startHlsNullSink(i, comment) {
        this._parent.PaCmdQueue(() => {
            // let cmd = `pactl load-module module-null-sink sink_name=${this._paModuleName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec},device.description='${this.description}'"`;
            let cmd = `pactl load-module module-null-sink sink_name=${this._controlName}_sink_${i} format=s${this.bitDepth}le rate=${this.sampleRate} channels=2 sink_properties="latency_msec=${this._parent.paLatency} device.description='${this._controlName}_sink_${i} (${comment})'"`;
            exec(cmd, { silent: true }).then(data => {
                if (data.stderr) {
                    this._parent._log('ERROR', data.stderr.toString());
                }

                if (data.stdout.length) {
                    this.sinkspaModuleID.push(data.stdout.toString().trim());
                    // save module id's to clear old modules on startup
                    this.NotifyProperty('sinkspaModuleID');
                    this.readyNullSinks ++;
                    this._parent._log('INFO', `${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paModuleID}  (sink_${i})`);
                }
            }).catch(err => {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}) - Unable to start null-sink  (sink_${i}): ` + err.message);
            });
        })
    }

    // Remove PulseAudio module
    _stopHlsNullSink(_paModuleID) {
        this._parent.PaCmdQueue(() => {
            if (_paModuleID) {
                let cmd = `pactl unload-module ${_paModuleID}`;
                exec(cmd, { silent: true }).then(data => {
                    if (data.stderr) {
                        this._parent._log('ERROR', data.stderr.toString());
                    } else {
                        this._parent._log('INFO', `${this._controlName} (${this.displayName}): Removed null-sink`);
                    }
                }).catch(err => {
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}):` + err.message);
                });
            }
        })
    }

    /**
     * Parse hls url with ffprobe
     * @param {String} url - hls url
     * @returns 
     */
    parse_hls(url){
        return new Promise((resolve, reject) => {
            exec(`ffprobe -v error -show_streams -of json -headers 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/117.0' -i "${url}"`, { maxBuffer: 1024 * 1000 }, (err, stdout, stderr) => {
                if (stdout) {
                    resolve(JSON.parse(stdout));
                }
                else {
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}):` + ` No data received for ${url}`);
                    resolve();
                }
            })
        })
    }

}

module.exports = HlsPlayer;