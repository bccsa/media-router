const _routerChildControlBase = require("./_routerChildControlBase");
const SrtBase = require("./SrtBase");
const { Classes } = require("../modular-dm");
const { url, parseStats } = require("./RIST/rist");
const path = require("path");
const Spawn = require("./spawn");

/**
 * Base class for RIST ↔ SRT conversion controls.
 * Subclasses must implement:
 *   - _buildPipeline()  → GStreamer pipeline string
 *   - _buildRistCmd()   → RIST CLI command string
 *   - _ristStartOrder() → "rist-first" or "srt-first"
 *   - _parseStats(data) → parsed stats array
 */
class _ristBase extends Classes(_routerChildControlBase, SrtBase) {
    constructor() {
        super();
        this.udpSocket = 40000;
        this.ready = true;
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
                `${this._controlName} (${this.displayName}): Starting ${this._srtElementName} (gstreamer)`
            );

            let _pipeline = this._buildPipeline();
            let rist = this._buildRistCmd();

            let srtCmd = `node ${path.dirname(
                process.argv[1]
            )}/child_processes/SrtGstGeneric_child.js '${_pipeline}'`;

            this._parent.PaCmdQueue(() => {
                if (this._ristStartOrder() === "rist-first") {
                    this._startSpawn(rist);
                    setTimeout(() => {
                        this._start_srt(srtCmd, this._srtElementName);
                    }, 1000);
                } else {
                    this._start_srt(srtCmd, this._srtElementName);
                    setTimeout(() => {
                        this._startSpawn(rist);
                    }, 1000);
                }
            });
        }
    }

    stopPipeline() {
        this._parent._log(
            "INFO",
            `${this._controlName} (${this.displayName}): Stopping ${this._srtElementName} (gstreamer)`
        );
        this._stop_srt();
        this.spawn.ready = false;
        this.spawn.run = this.run;
        this.spawn.stop_cmd();
    }

    _startSpawn(cmd) {
        this.spawn.ready = true;
        this.spawn.run = this.run;
        this.spawn.start_cmd(cmd);
    }

    _ristStats(_d) {
        const data = this._parseStats(_d);
        data.forEach((d) => {
            const id = `${this._controlName}_${d.cname}_${d.id}`;
            this.Set({ [id]: d });
            this._notify({ [id]: this[id].Get() });
        });
    }

    /** @returns {string} GStreamer pipeline string */
    _buildPipeline() {
        throw new Error("Subclass must implement _buildPipeline()");
    }

    /** @returns {string} RIST CLI command */
    _buildRistCmd() {
        throw new Error("Subclass must implement _buildRistCmd()");
    }

    /** @returns {"rist-first"|"srt-first"} Which process to start first */
    _ristStartOrder() {
        throw new Error("Subclass must implement _ristStartOrder()");
    }

    /** @returns {Array} Parsed stats */
    _parseStats(_d) {
        throw new Error("Subclass must implement _parseStats()");
    }
}

module.exports = _ristBase;
