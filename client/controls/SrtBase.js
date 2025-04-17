const { SrtBaseHtml, SrtStatsHtml } = require("controls/SrtBase/html");

class SrtBase {
    constructor() {
        this.srtHost = "";
        this.srtPort = 1234;
        this.srtMode = "caller";
        this.srtPbKeyLen = 16;
        this.srtPassphrase = "";
        this.srtLatency = 10;
        this.srtMaxBw = 250; // % of Bandwidth
        this.srtEnableMaxBW = false; // Enable MaxBandwidth property for srt
        this.srtStreamID = "";
        this.caller_count = 0; // amount of callers connected to module
    }

    SrtBaseHtml(
        title = "SRT Settings",
        prop_host = "srtHost",
        prop_port = "srtPort",
        prop_mode = "srtMode",
        prop_PbKeyLen = "srtPbKeyLen",
        prop_passphrase = "srtPassphrase",
        prop_latency = "srtLatency",
        prop_maxBw = "srtMaxBw",
        prop_enableMaxBw = "srtEnableMaxBW",
        prop_streamId = "srtStreamID",
        prop_portWarning = "srtPortWarning"
    ) {
        // ========================== validators =========================
        const _this = this;
        // ========================= SrtHost
        this.on(
            prop_mode,
            async () => {
                // wait for prop to be ready
                while (!_this[`_${prop_port}`] || !_this[`_${prop_host}`])
                    await new Promise((res) => setTimeout(res, 1000));

                // unpublish port if mode is caller
                if (_this[prop_mode] === "caller")
                    _this._parent.unpublishPort(_this.name, "udp");

                // hide host if mode is listener
                if (_this[prop_mode] === "listener")
                    _this[`_${prop_host}`].style.display = "none";
                else _this[`_${prop_host}`].style.display = "block";
            },
            { immediate: true }
        );

        // ========================= SrtPort

        this.on(
            prop_port,
            async () => {
                // wait for prop to be ready
                while (!_this[prop_portWarning] || !_this[prop_port])
                    await new Promise((res) => setTimeout(res, 1000));
                if (_this[prop_mode] === "caller") return;
                // only check for listen
                const warn = _this._parent.publishPort(
                    _this.name,
                    "udp",
                    _this[prop_port]
                );

                if (!warn) {
                    _this[prop_portWarning].style.display = "none";
                    return;
                }
                _this[prop_portWarning].innerHTML = warn;
                _this[prop_portWarning].style.display = "block";
            },
            { immediate: true }
        );

        // ========================== validators =========================

        return SrtBaseHtml(
            title,
            prop_host,
            prop_port,
            prop_mode,
            prop_PbKeyLen,
            prop_passphrase,
            prop_latency,
            prop_maxBw,
            prop_enableMaxBw,
            prop_streamId,
            prop_portWarning
        );
    }

    SrtStatsHtml() {
        return SrtStatsHtml();
    }

    /**
     * Initialize SRT spesific
     */
    _SrtInit() {
        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/SrtBase/README.md"); // Load aditional MD
        //----------------------Help Modal-----------------------------//

        // Display Srt stats button
        this._btnSrtStats.style.display = "block";

        //----------------------SrtStats Modal-----------------------------//
        this._modalSrtStats.style.display = "none";
        this._btnSrtStats.addEventListener("click", (e) => {
            this._modalSrtStats.style.display = "block";
            this._SettingsContent.style.display = "none";
            this._modalHelp.style.display = "none";
        });
        this._btnSettings.addEventListener("click", (e) => {
            this._modalSrtStats.style.display = "none";
            this._SettingsContent.style.display = "block";
        });
        //----------------------SrtStats Modal-----------------------------//

        //----------------------SrtStats Modification-----------------------------//
        this.on(
            "srtMode",
            (mode) => {
                if (mode == "listener") {
                    this._callerCount.style.display = "block";
                } else {
                    this._callerCount.style.display = "none";
                }
            },
            { immediate: true }
        );

        this.on(
            "caller_count",
            (_c) => {
                if (_c == 0) this._SrtConnectionStat("disconnected");
                else this._SrtConnectionStat();
            },
            { immediate: true }
        );

        // Enable disable / maxBandwidth
        this.on(
            "srtEnableMaxBW",
            (res) => {
                if (!res) {
                    this.srtMaxBw_div.style.display = "none";
                } else {
                    this.srtMaxBw_div.style.display = "block";
                }
            },
            { immediate: true }
        );

        //----------------------SrtStats Modification-----------------------------//
    }

    _SrtConnectionStat(status) {
        if (status == "disconnected") {
            this._draggable.style["background-color"] = "#a1151a";
        } else {
            this._draggable.style["background-color"] = "#1E293B";
        }
    }
}
