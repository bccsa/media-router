const _routerChildControlBase = require("./_routerChildControlBase");
const SrtBase = require("./SrtBase");
const { Classes } = require("../modular-dm");
const { url } = require("./RIST/rist");
const path = require("path");
const Spawn = require("./spawn");

class SrtToRist extends Classes(_routerChildControlBase, SrtBase) {
    constructor() {
        super();
        this.udpSocket = 40000;
        this.buffer = 75;
        this.ready = true;
        this._srtElementName = "SrtToRist";
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
                `${this._controlName} (${this.displayName}): Starting srtToRist (gstreamer)`
            );

            let _pipeline = `srtserversrc uri="${this.uri()}" wait-for-connection=false name="${
                this._srtElementName
            }" ! udpsink port=${this.udpSocket} host=127.0.0.1`;

            let rist = `ristsender --buffer ${this.buffer} -i udp://127.0.0.1:${
                this.udpSocket
            } -o "${url(this._controls)}"`;

            this._parent.PaCmdQueue(() => {
                this._start_srt(
                    `node ${path.dirname(
                        process.argv[1]
                    )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`,
                    this._srtElementName
                );

                setTimeout(() => {
                    this.spawn.ready = true;
                    this.spawn.run = this.run;
                    this.spawn.start_cmd(rist);
                }, 1000);
            });
        }
    }

    stopPipeline() {
        this._parent._log(
            "INFO",
            `${this._controlName} (${this.displayName}): Stopping srtToRist (gstreamer)`
        );
        this._stop_srt();
        this.spawn.ready = false;
        this.spawn.run = this.run;
        this.spawn.stop_cmd();
    }

    _ristStats(_d) {
        if (!_d) return;
        const data = _d.toString();
        if (!data) return;
        const parsedObjects = data
            .trim()
            .split("\n")
            .filter((line) => line.includes("{") && line.includes("}")) // keep only lines with JSON
            .map((line) => {
                const [, , jsonStr] = line.split("|");
                try {
                    const json = JSON.parse(jsonStr.trim().split("[INFO]")[1]);
                    return json;
                } catch (e) {
                    return null; // skip malformed JSON just in case
                }
            })
            .filter((obj) => obj !== null); // remove null entries

        if (parsedObjects.length == 0) return;
        console.log(parsedObjects);
    }
}

module.exports = SrtToRist;
