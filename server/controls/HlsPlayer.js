const _paNullSinkBase = require("./_paNullSinkBase");
const path = require("path");
const SrtBase = require("./SrtBase");
const { Classes } = require("../modular-dm");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const axios = require("axios");
const HLS = require("hls-parser");

class HlsPlayer extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
        this.hlsUrl = "";
        this.videoQuality = "";
        this.videoQualities = [];
        this.subtitleLanguage = "off";
        this.subtitleLanguages = [];
        this.subtitlePosition = "baseline";
        this.videoDelay = 0;
        this.sinkspaModuleID = [];
        this.readyNullSinks = 0;
        this.audioStreams = [];
        this._enabledStreams = 0;
        this.defaultLanguage = "";
        this.enableSrt = false;
        this.runningSrt = false;
        this.hlsLoading = false;
        this._videoElementName = "videoSink";
    }

    Init() {
        super.Init();
        // Start external processes when the underlying null-sink is ready (from extended class)
        this.on("ready", (ready) => {
            if (ready) {
                // start null sinks
                this._enabledStreams = 0;
                this.readyNullSinks = -1; // Toggle to -1 that the event triggers if there is cuttrntly 0 ready null sinks and none is started
                this.readyNullSinks = 0;
                this.audioStreams.forEach((stream) => {
                    if (
                        stream.enabled &&
                        stream.language != this.defaultLanguage
                    ) {
                        this._enabledStreams++;
                        this._startHlsNullSink(stream.language, stream.comment);
                    }
                });
            }

            // reset hlsLoading
            this.hlsLoading = false;
        });

        this.on("readyNullSinks", () => {
            this.startPipeline();
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on(
            "run",
            (run) => {
                this.startPipeline(this.readyNullSinks);
                if (!run) {
                    if (this.runningSrt) {
                        this._stop_srt();
                    } else {
                        this.stop_gst();
                    }

                    while (this.sinkspaModuleID.length > 0) {
                        this._stopHlsNullSink(this.sinkspaModuleID.pop());
                    }
                }
            },
            { immediate: true }
        );

        this.on("hlsUrl", async (url) => {
            this.hlsLoading = true;
            const res = await this.parse_hls(url);

            if (res?.length) {
                const availableAudio = res.filter((s) => s.type === "audio");
                const availableVideo = res.filter(
                    (s) => s.type === "video" && s.height > 0
                );

                // Remove unavailable sources and maintain enabled states
                this.audioStreams = availableAudio.reduce((arr, s, i) => {
                    if (!arr.some((a) => a.language === s.language)) {
                        const existing = this.audioStreams.find(
                            (a) => a.language === s.language
                        );
                        arr.push({
                            language: s.language,
                            comment: s.name,
                            index: i,
                            enabled: existing ? existing.enabled : false,
                        });
                    }
                    return arr;
                }, []);

                this.videoQualities = availableVideo.map((s) => `${s.height}`);
                this.subtitleLanguages = availableAudio.map((s) => {
                    return { language: s.language, comment: s.name };
                });

                // remove selected sub if it is not in the subtitleLanguages
                if (
                    !this.subtitleLanguages.some(
                        (s) => s.language === this.subtitleLanguage
                    )
                )
                    this.subtitleLanguage = "off";

                // Set default language if not available
                if (
                    !this.audioStreams.some(
                        (c) => c.language === this.defaultLanguage
                    ) &&
                    this.audioStreams.length
                ) {
                    this.defaultLanguage = this.audioStreams[0].language;
                }

                // Set default video quality if not available
                if (
                    !this.videoQualities.includes(this.videoQuality) &&
                    this.videoQualities.length
                ) {
                    this.videoQuality =
                        this.videoQualities[this.videoQualities.length - 1];
                }
                [
                    "audioStreams",
                    "videoQualities",
                    "defaultLanguage",
                    "videoQuality",
                    "subtitleLanguages",
                    "subtitleLanguage",
                ].forEach((prop) => this.NotifyProperty(prop));
            }

            this.hlsLoading = false;
        });

        this.on("videoDelay", (d) => {
            this.set_gst("audioSink", "int", "ts-offset", d);
            this.set_gst(
                this._videoElementName,
                "int",
                "ts-offset",
                d * 1000000
            );
        });
    }

    startPipeline() {
        if (!this.ready || !this.run) return;

        // isEnabled (Allow pipeline to start if none of the sinks is enabled)
        let isEnabled = false;
        this.audioStreams.forEach((s) => {
            if (!isEnabled) isEnabled = s.enabled;
        });
        if (
            (this.readyNullSinks < 0 ||
                this.readyNullSinks !== this._enabledStreams) &&
            isEnabled
        )
            return;

        // Source
        let lang = [];
        this.audioStreams.forEach((stream) => {
            if (stream.enabled || stream.language == this.defaultLanguage) {
                lang.push(stream.language);
            }
        });

        // ================ HLS Demuxer ===================
        let hlsDemuxer = `node ${path.dirname(
            process.argv[1]
        )}/hlsDemuxer/index.js "${this.hlsUrl}" '${JSON.stringify({
            languages: lang,
            maxQuality: this.videoQuality,
            subtitleLanguage:
                this.subtitleLanguage == "off" ? "" : this.subtitleLanguage,
        })}'`;

        let _pipeline = `${this._video()} ${this._audio()} ${this._subtitles()}`;

        // ------------ start sound processor ------------ //
        if (!this.hlsUrl) return;
        this._parent.PaCmdQueue(() => {
            if (this.enableSrt) {
                this.runningSrt = true;
                this._start_srt(
                    `${hlsDemuxer} & sleep 3 && node ${path.dirname(
                        process.argv[1]
                    )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`,
                    this._videoElementName
                );
            } else {
                this.runningSrt = false;
                this.start_gst(
                    `${hlsDemuxer} & sleep 3 && node ${path.dirname(
                        process.argv[1]
                    )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`
                );
            }
        });
    }

    _src = (pipe, isSrt = false) => {
        if (isSrt)
            return `filesrc location="${pipe}" ! queue2 use-buffering=true max-size-time=400000000 ! parsebin`;
        return `filesrc location="${pipe}" ! queue2 use-buffering=true max-size-time=400000000 ! parsebin ! decodebin3 ! queue`;
    };

    _video() {
        let video = "";

        if (!this.enableSrt)
            // local playout
            video = `${this._src(
                "/tmp/videoPipe"
            )} ! textoverlay wait-text=false valignment=${
                this.subtitlePosition
            } name=ov ! kmssink sync=true`;
        else if (this.enableSrt)
            // srt without subtitles
            video = `${this._src(
                "/tmp/videoPipe",
                true
            )} ! h264parse ! mpegtsmux alignment=7 name=mux ! queue ! srtserversink name="${
                this._videoElementName
            }" wait-for-connection=false sync=true ts-offset=${
                this.videoDelay * 1000000
            } uri="${this.uri()}"`;

        return video;
    }

    _audio() {
        let audio = "";
        this.audioStreams.forEach((stream) => {
            if (!stream.enabled && stream.language !== this.defaultLanguage)
                return;

            if (stream.language == this.defaultLanguage) {
                if (this.enableSrt)
                    audio += ` ${this._src(
                        `/tmp/${stream.language}_audioPipe`,
                        true
                    )} ! tee name=tee ! queue ! mux.`;

                audio += ` ${
                    !this.enableSrt
                        ? this._src(`/tmp/${stream.language}_audioPipe`)
                        : `tee. ! decodebin3 `
                } ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink name=audioSink ts-offset=${
                    this.videoDelay * 1000000
                } device=${
                    this.sink
                } sync=true slave-method=0 processing-deadline=40000000 buffer-time=${
                    this._parent.paLatency * 1000
                } max-lateness=${this._parent.paLatency * 1000000}`;
            } else
                audio += ` ${this._src(
                    `/tmp/${stream.language}_audioPipe`
                )} ! audioconvert ! audio/x-raw,channels=2 ! queue ! pulsesink device=${
                    this._controlName
                }_sink_${
                    stream.language
                } sync=false slave-method=0 processing-deadline=40000000 buffer-time=${
                    this._parent.paLatency * 1000
                } max-lateness=${this._parent.paLatency * 1000000}`;
        });

        return audio;
    }

    _subtitles() {
        let subs = "";
        if (
            this.subtitleLanguage &&
            this.subtitleLanguage !== "off" &&
            !this.enableSrt
        )
            // only enable subtitles if srt is disabled or the user explicity enables subtitles for srt
            subs = ` filesrc location="/tmp/${this.subtitleLanguage}_subtitlePipe" ! queue ! parsebin ! decodebin3 ! queue ! ov.text_sink`;
        else if (
            this.subtitleLanguage &&
            this.subtitleLanguage !== "off" &&
            this.enableSrt
        )
            // subtitles is not yet supported on srt
            subs = ` filesrc location="/tmp/${this.subtitleLanguage}_subtitlePipe" ! queue ! fakesink sync=true`;
        return subs;
    }

    // Create a PulseAudio loopback-module linking the source to the sink
    _startHlsNullSink(i, comment) {
        this._parent.PaCmdQueue(() => {
            // let cmd = `pactl load-module module-null-sink sink_name=${this._paModuleName} format=s${this.bitdepth}le rate=${this.sampleRate} channels=${this.channels} sink_properties="latency_msec=${this.latency_msec},device.description='${this.description}'"`;
            let cmd = `pactl load-module module-null-sink sink_name=${this._controlName}_sink_${i} format=s${this.bitDepth}le rate=${this.sampleRate} channels=2 sink_properties="latency_msec=${this._parent.paLatency} device.description='${this._controlName}_sink_${i} (${comment})'"`;
            exec(cmd, { silent: true })
                .then((data) => {
                    if (data.stderr) {
                        this._parent._log("ERROR", data.stderr.toString());
                    }

                    if (data.stdout.length) {
                        this.sinkspaModuleID.push(
                            data.stdout.toString().trim()
                        );
                        // save module id's to clear old modules on startup
                        this.NotifyProperty("sinkspaModuleID");
                        this.readyNullSinks++;
                        this._parent._log(
                            "INFO",
                            `${this._controlName} (${this.displayName}): Created null-sink; ID: ${this._paModuleID}  (sink_${i})`
                        );
                    }
                })
                .catch((err) => {
                    this._parent._log(
                        "FATAL",
                        `${this._controlName} (${this.displayName}) - Unable to start null-sink  (sink_${i}): ` +
                            err.message
                    );
                });
        });
    }

    // Remove PulseAudio module
    _stopHlsNullSink(_paModuleID) {
        this._parent.PaCmdQueue(() => {
            if (_paModuleID) {
                let cmd = `pactl unload-module ${_paModuleID}`;
                exec(cmd, { silent: true })
                    .then((data) => {
                        if (data.stderr) {
                            this._parent._log("ERROR", data.stderr.toString());
                        } else {
                            this._parent._log(
                                "INFO",
                                `${this._controlName} (${this.displayName}): Removed null-sink`
                            );
                        }
                    })
                    .catch((err) => {
                        this._parent._log(
                            "FATAL",
                            `${this._controlName} (${this.displayName}):` +
                                err.message
                        );
                    });
            }
        });
    }

    /**
     * Parse hls url with ffprobe
     * @param {String} url - hls url
     * @returns
     */
    parse_hls(url) {
        return new Promise(async (resolve, reject) => {
            let playlist = await this.fetchPlaylist(url);
            if (!playlist.variants) resolve({});
            else {
                let streams = [];
                for (const v of playlist.variants) {
                    streams.push({
                        type: "video",
                        height: v.resolution.height,
                        codec: v.codecs,
                    });
                }
                for (const a of playlist.variants[0].audio) {
                    streams.push({
                        type: "audio",
                        language: a.language,
                        name: a.name,
                    });
                }

                resolve(streams);
            }
        });
    }

    /**
     * Fetches and parses an HLS playlist from a given URL.
     * @param {string} url - The URL of the HLS playlist.
     * @returns {Promise<object|null>} - The parsed playlist or null if fetching fails.
     */
    async fetchPlaylist(url) {
        try {
            const response = await axios.get(url);
            return HLS.parse(response.data);
        } catch (error) {
            this._parent._log(
                "FATAL",
                `Error fetching playlist: ${error.message}`
            );
            return {};
        }
    }
}

module.exports = HlsPlayer;
