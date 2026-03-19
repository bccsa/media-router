class SrtRelay extends _uiClasses(_routerChildControlBase, SrtBase) {
    constructor() {
        super();
        this.sink_srtHost = "";
        this.sink_srtPort = 1234;
        this.sink_srtMode = "caller";
        this.sink_srtPbKeyLen = 16;
        this.sink_srtPassphrase = "";
        this.sink_srtLatency = 10;
        this.sink_srtMaxBw = 250; // % of Bandwidth
        this.sink_srtEnableMaxBW = false; // Enable MaxBandwidth property for srt
        this.sink_srtStreamID = "";
    }

    get html() {
        return super.html
            .replace(
                "%modalHtml%",
                `

        ${this.SrtBaseHtml(
            "SRT Receiver Settings",
            "sink_srtHost",
            "sink_srtPort",
            "sink_srtMode",
            "sink_srtPbKeyLen",
            "sink_srtPassphrase",
            "sink_srtLatency",
            "sink_srtMaxBw",
            "sink_srtEnableMaxBW",
            "sink_srtStreamID",
            "sink_srtHostWarning",
            "sink_srtPortWarning"
        )}

        ${this.SrtBaseHtml("SRT Transmitter Settings")}
        `
            )
            .replace("<!--  %SrtStatsHtml%  -->", this.SrtStatsHtml())
            .replace(
                "%cardHtml%",
                `
        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">Srt Relay</div>
        `
            );
    }

    Init() {
        super.Init();
        this.setHeaderColor("#00c3c3");

        // init SRT Spesific
        this._SrtInit();

        // Enable disable / maxBandwidth
        this.on(
            "sink_srtEnableMaxBW",
            (res) => {
                if (!res) {
                    this.sink_srtMaxBw_div.style.display = "none";
                } else {
                    this.sink_srtMaxBw_div.style.display = "block";
                }
            },
            { immediate: true }
        );

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/SrtRelay.md");
        //----------------------Help Modal-----------------------------//
    }
}
