const _paNullSinkBase = require("./_paNullSinkBase");
const SrtBase = require("./SrtBase");
const path = require("path");
const fs = require("fs");
const { Classes } = require("../modular-dm");

class SrtVideoPlayer extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
        this._srtElementName = "srtserversrc";
    }

    Init() {
        super.Init();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on("ready", (ready) => {
            this.startPipeline();
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on("run", (run) => {
            if (!run) this._stop_srt();
            this.startPipeline();
        });
    }

    startPipeline() {
        if (this.ready && this.run) {
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Starting srt video decoder (gstreamer)`
            );

            // Check if Wayland is available by looking in XDG_RUNTIME_DIR for wayland-* sockets
            const waylandDisplay = getWaylandDisplay();
            
            const videoSink = waylandDisplay 
                ? `waylandsink display=${waylandDisplay} sync=false async=false` 
                : 'kmssink sync=false async=false';
            
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Using video sink: ${waylandDisplay ? `waylandsink (${waylandDisplay})` : 'kmssink (KMS/DRM)'}`
            );

            let _pipeline =
                `srtserversrc name=${
                    this._srtElementName
                } uri="${this.uri()}" wait-for-connection=false ! ` +
                `tsparse ! tsdemux latency=1 name=t t. ! ` +
                `h264parse ! decodebin max-size-time=40000000 ! ` +
                `queue flush-on-eos=true leaky=2 max-size-time=50000000 ! ` +
                `${videoSink} t. ! ` +
                `aacparse ! avdec_aac ! audioconvert ! ` +
                `queue flush-on-eos=true leaky=2 max-size-time=50000000 ! ` +
                `pulsesink device=${this.sink} sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=50000000`;

            this._parent.PaCmdQueue(() => {
                this._start_srt(
                    `node ${path.dirname(
                        process.argv[1]
                    )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`,
                    this._srtElementName
                );
            });
        }
    }
}

function getWaylandDisplay() {
    let waylandDisplay = null;
    const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
            
    if (xdgRuntimeDir && fs.existsSync(xdgRuntimeDir)) {
        try {
            const files = fs.readdirSync(xdgRuntimeDir);
            const waylandFiles = files
                .filter(file => file.startsWith('wayland-'))
                .sort(); // Sort to get wayland-0 before wayland-1, etc.
            
            if (waylandFiles.length > 0) {
                waylandDisplay = waylandFiles[0];
            }
        } catch (err) {
            this._parent._log(
                "WARN",
                `${this._controlName} (${this.displayName}): Could not read XDG_RUNTIME_DIR: ${err.message}`
            );
        }
    }
    return waylandDisplay;
}

module.exports = SrtVideoPlayer;
