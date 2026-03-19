const _paNullSinkBase = require("./_paNullSinkBase");
const SrtBase = require("./SrtBase");
const path = require("path");
const { Classes } = require("../modular-dm");

class SrtOpusInput extends Classes(_paNullSinkBase, SrtBase) {
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
            let _pipeline =
                `srtserversrc name=${
                    this._srtElementName
                } uri="${this.uri()}" wait-for-connection=false ! ` +
                `decodebin max-size-time=40000000 ! ` +
                `audioconvert ! ` +
                `audio/x-raw,rate=${this.sampleRate},format=S${this.bitDepth}LE,channels=${this.channels} ! ` +
                `queue leaky=2 max-size-time=40000000 flush-on-eos=true ! ` +
                `pulsesink device="${this.sink}" sync=false slave-method=0 processing-deadline=40000000 buffer-time=50000 max-lateness=40000000`;

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

module.exports = SrtOpusInput;
