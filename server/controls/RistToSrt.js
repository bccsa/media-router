const _routerChildControlBase = require("./_routerChildControlBase");
const SrtBase = require("./SrtBase");
const { Classes } = require("../modular-dm");
const { url, parseStats } = require("./RIST/rist");
const path = require("path");
const Spawn = require("./spawn");

class RistToSrt extends Classes(_routerChildControlBase, SrtBase) {
    constructor() {
        super();
        this.udpSocket = 40000;
        this.buffer = 75;
        this.ready = true;
        this._srtElementName = "RistToSrt";
        this.spawn = new Spawn();
        this.spawn.stderrCallback = this._ristStats.bind(this);
    }

    Init() {
        super.Init();
        this.InitBase();

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on("run", (run) => {
            if (!run) this.stopPipeline();
            this.startPipeline();
        });
    }

    startPipeline() {
        if (this.run && this.moduleEnabled) {
            if (!this._controls || Object.values(this._controls).length === 0) {
                this._parent._log(
                    "ERROR",
                    `${this._controlName} (${this.displayName}): No RIST link found`
                );
                return;
            }

            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}): Starting RistToSrt (gstreamer)`
            );

            let _pipeline =
                `udpsrc port=${this.udpSocket} address=127.0.0.1 ! ` +
                `srtserversink uri="${this.uri()}" wait-for-connection=false name="${
                    this._srtElementName
                }" sync=false`;

            let rist = `ristreceiver --buffer ${this.buffer} -i "${url(
                this._controls
            )}" -o udp://127.0.0.1:${this.udpSocket} `;

            this._parent.PaCmdQueue(() => {
                this.spawn.ready = true;
                this.spawn.run = this.run;
                this.spawn.start_cmd(rist);

                setTimeout(() => {
                    this._start_srt(
                        `node ${path.dirname(
                            process.argv[1]
                        )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`,
                        this._srtElementName
                    );
                }, 1000);
            });
        }
    }

    stopPipeline() {
        this._parent._log(
            "INFO",
            `${this._controlName} (${this.displayName}): Stopping RistToSrt (gstreamer)`
        );
        this._stop_srt();
        this.spawn.ready = false;
        this.spawn.run = this.run;
        this.spawn.stop_cmd();
    }

    _ristStats(_d) {
        console.log(parseStats(_d));
    }
}

module.exports = RistToSrt;
