const _paNullSinkBase = require("./_paNullSinkBase");
const path = require("path");
const SrtBase = require("./SrtBase");
const { Classes } = require("../modular-dm");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const HlsParser = require("./HlsPlayer/hlsParser");
const NullSinks = require("./HlsPlayer/nullSinks");

class HlsPlayer extends Classes(
    _paNullSinkBase,
    SrtBase,
    HlsParser,
    NullSinks
) {
    constructor() {
        super();
        this.videoQuality = "";
        this.subtitleLanguage = "off";
        this.subtitlePosition = "baseline";
        this.videoDelay = 0;
        this.defaultLanguage = "";
        this.enableSrt = false;
        this.runningSrt = false;
        this._videoElementName = "videoSink";
    }

    Init() {
        super.Init();
        this.InitHlsParser();
        this.InitNullSinks();

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
                }
            },
            { immediate: true }
        );

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
            moduleIdentifier: this._controlName,
        })}'`;

        let _pipeline = `${this._video()} ${this._audio()} ${this._subtitles()}`;
        console.log(_pipeline);

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
            // local payout
            video = `${this._src(
                `/tmp/${this._controlName}_videoPipe`
            )} ! textoverlay wait-text=false valignment=${
                this.subtitlePosition
            } name=ov ! kmssink sync=true`;
        else if (this.enableSrt)
            // srt without subtitles
            video = `${this._src(
                `/tmp/${this._controlName}_videoPipe`,
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
                        `/tmp/${this._controlName}_${stream.language}_audioPipe`,
                        true
                    )} ! tee name=tee ! queue ! mux.`;
                audio += ` ${
                    !this.enableSrt
                        ? this._src(
                              `/tmp/${this._controlName}_${stream.language}_audioPipe`
                          )
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
                    `/tmp/${this._controlName}_${stream.language}_audioPipe`
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
            subs = ` filesrc location="/tmp/${this._controlName}_${this.subtitleLanguage}_subtitlePipe" ! queue ! parsebin ! decodebin3 ! queue ! ov.text_sink`;
        else if (
            this.subtitleLanguage &&
            this.subtitleLanguage !== "off" &&
            this.enableSrt
        )
            // subtitles is not yet supported on srt
            subs = ` filesrc location="/tmp/${this._controlName}_${this.subtitleLanguage}_subtitlePipe" ! queue ! fakesink sync=true`;
        return subs;
    }
}

module.exports = HlsPlayer;
