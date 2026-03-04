const _paNullSinkBase = require("./_paNullSinkBase");
const path = require("path");
const SrtBase = require("./SrtBase");
const { Classes } = require("../modular-dm");
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

        // Debounced restart when user moves the start time slider during playback
        this._startTimeTimeout = null;
        this._suppressStartTimeRestart = false;
        this.on("hlsStartTime", () => {
            if (this._suppressStartTimeRestart) return;
            if (!this.run || !this.hlsIsVod || this.hlsPaused) return;
            // Stop position reader and sync current time immediately
            // so stale values don't cause the slider to jump back
            this._stopPositionReader();
            this.hlsCurrentTime = this.hlsStartTime;
            this.NotifyProperty("hlsCurrentTime");
            clearTimeout(this._startTimeTimeout);
            this._startTimeTimeout = setTimeout(() => {
                if (this.runningSrt) {
                    this._stop_srt();
                } else {
                    this.stop_gst();
                }
                // Delay to let the pipeline fully stop before restarting
                setTimeout(() => {
                    this.startPipeline();
                }, 1500);
            }, 1000);
        });

        // Reset pause state on reload
        this.on("reload", (reload) => {
            if (reload && this.hlsPaused) {
                this.hlsPaused = false;
                this.NotifyProperty("hlsPaused");
            }
        });

        // Pause/Play (VOD only)
        this._positionInterval = null;
        this.on("hlsPaused", (paused) => {
            if (!this.hlsIsVod) return;
            if (paused) {
                this._stopPositionReader();
                // Set start time to current position so resume starts here
                this._suppressStartTimeRestart = true;
                this.hlsStartTime = this.hlsCurrentTime;
                this.NotifyProperty("hlsStartTime");
                this._suppressStartTimeRestart = false;
                if (this.runningSrt) {
                    this._stop_srt();
                } else {
                    this.stop_gst();
                }
            } else {
                this.startPipeline();
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on(
            "run",
            (run) => {
                this.startPipeline(this.readyNullSinks);
                if (!run) {
                    this._stopPositionReader();
                    if (this.runningSrt) {
                        this._stop_srt();
                    } else {
                        this.stop_gst();
                    }
                }
            },
            { immediate: true }
        );
    }

    startPipeline() {
        if (!this.ready || !this.run || this.hlsPaused) return;

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
        // Escape single quotes in JSON config to prevent shell injection
        const configJson = JSON.stringify({
            languages: lang,
            maxQuality: this.videoQuality,
            subtitleLanguage: this.enableSrt
                ? ""
                : this.subtitleLanguage == "off"
                ? ""
                : this.subtitleLanguage,
            moduleIdentifier: this._controlName,
            startTime: this.hlsStartTime || 0,
        }).replace(/'/g, "'\\''");

        // Escape shell metacharacters in URL
        const safeUrl = this.hlsUrl
            .replace(/\$/g, "\\$")
            .replace(/`/g, "\\`");

        const serverDir = path.dirname(process.argv[1]);
        let hlsDemuxer = `node ${serverDir}/hlsDemuxer/index.js "${safeUrl}" '${configJson}'`;

        // Wait up to 30 seconds for the demuxer to create pipes (marker file)
        // instead of using a fixed sleep 3
        const markerFile = `/tmp/${this._controlName}_hls_ready`;
        const waitForReady = `i=0; while [ ! -f ${markerFile} ] && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done; rm -f ${markerFile}`;

        let _pipeline = `${this._video()} ${this._audio()} ${this._subtitles()}`;

        // ------------ start sound processor ------------ //
        if (!this.hlsUrl) return;
        this._startPositionReader();
        this._parent.PaCmdQueue(() => {
            const gstChild = `node ${serverDir}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`;
            if (this.enableSrt) {
                this.runningSrt = true;
                this._start_srt(
                    `${hlsDemuxer} & ${waitForReady} && ${gstChild}`,
                    this._videoElementName
                );
            } else {
                this.runningSrt = false;
                this.start_gst(
                    `${hlsDemuxer} & ${waitForReady} && ${gstChild}`
                );
            }
        });
    }

    _startPositionReader() {
        this._stopPositionReader();
        if (!this.hlsIsVod) return;
        this._playbackStartedAt = Date.now();
        this._playbackStartValue = this.hlsStartTime || 0;
        this._positionInterval = setInterval(() => {
            const elapsed = (Date.now() - this._playbackStartedAt) / 1000;
            const pos = Math.min(
                Math.floor(this._playbackStartValue + elapsed),
                this.hlsDuration
            );
            if (pos !== this.hlsCurrentTime) {
                this.hlsCurrentTime = pos;
                this.NotifyProperty("hlsCurrentTime");
            }
        }, 1000);
    }

    _stopPositionReader() {
        clearInterval(this._positionInterval);
        this._positionInterval = null;
    }

    _src = (pipe, isSrt = false) => {
        if (isSrt)
            return `filesrc location="${pipe}" ! queue2 use-buffering=true max-size-time=60000000 ! parsebin`;
        return `filesrc location="${pipe}" ! queue2 use-buffering=true max-size-time=60000000 ! parsebin ! decodebin3 ! queue2 use-buffering=true max-size-time=60000000 `;
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
            )} ! h264parse config-interval=-1 ! mpegtsmux alignment=7 name=mux ! queue2 use-buffering=true max-size-time=80000000 ! srtserversink name="${
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
                    )} ! tee name=tee ! queue2 use-buffering=true max-size-time=60000000  ! mux.`;
                audio += ` ${
                    !this.enableSrt
                        ? this._src(
                              `/tmp/${this._controlName}_${stream.language}_audioPipe`
                          )
                        : `tee. ! decodebin3 `
                } ! audioconvert ! audio/x-raw,channels=2 ! queue2 use-buffering=true max-size-time=60000000 ! pulsesink name=audioSink ts-offset=${
                    this.videoDelay * 1000000
                } device=${
                    this.sink
                } sync=true slave-method=1 processing-deadline=60000000 buffer-time=${
                    this._parent.paLatency * 1000
                } max-lateness=${this._parent.paLatency * 1000000}`;
            } else
                audio += ` ${this._src(
                    `/tmp/${this._controlName}_${stream.language}_audioPipe`
                )} ! audioconvert ! audio/x-raw,channels=2 ! queue2 use-buffering=true max-size-time=60000000 ! pulsesink device=${
                    this._controlName
                }_sink_${
                    stream.language
                } sync=true slave-method=1 processing-deadline=60000000 buffer-time=${
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
            subs = ` filesrc location="/tmp/${this._controlName}_${this.subtitleLanguage}_subtitlePipe" ! queue2 use-buffering=true max-size-time=60000000 ! parsebin ! decodebin3 ! queue2 use-buffering=true max-size-time=60000000 ! ov.text_sink`;
        return subs;
    }
}

module.exports = HlsPlayer;
