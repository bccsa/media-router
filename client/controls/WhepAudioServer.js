const SVE = require("controls/WhepAudioServer/html");

class WhepAudioServer extends _paAudioSinkBase {
    constructor() {
        super();
        this.port = 9090; // Default port for WHEP server
        this.opusFec = false; // Enable Opus Forward Error Correction
        this.opusFecPacketLoss = 5; // Opus FEC packet loss percentage (preset value)
        this.opusComplexity = 10; // Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.opusBitrate = 64; // Opus encoding target bitrate in kbps
        this.opusFrameSize = 20; // Opus frame size
        this.rtpRed = false; // Enable RED (Redundant Encoding Data) for Opus
        this.rtpRedDistance = 2; // RTP RED distance (0: disable)
        // statistics
        this.rtt = []; // Round-trip time for the WHEP server
        this.packetLoss = []; // Packet loss statistics for the WHEP server
        this._rttChart = undefined; // Chart instance for displaying stats
        this._packetLossChart = undefined; // Chart instance for displaying stats
        this.clientCount = 0; // Number of clients connected to the WHEP server
    }

    get html() {
        return super.html
            .replace(
                "%additionalHtml%",
                `
            ${SVE.html()}
        `
            )
            .replace("<!--  %SrtStatsHtml%  -->", SVE.statsHtml());
    }

    Init() {
        super.Init();
        this.setHeaderColor("#007F6A");

        // Display Srt stats button
        this._btnSrtStats.style.display = "block";

        //----------------------SrtStats Modal-----------------------------//
        this._modalStats.style.display = "none";
        this._btnSrtStats.addEventListener("click", (e) => {
            this._modalStats.style.display = "block";
            this._SettingsContent.style.display = "none";
            this._modalHelp.style.display = "none";
        });
        this._btnSettings.addEventListener("click", (e) => {
            this._modalStats.style.display = "none";
            this._SettingsContent.style.display = "block";
        });
        //----------------------SrtStats Modal-----------------------------//
        //----------------------SrtStats Modification-----------------------------//

        this.createChart(
            "_rttChart",
            this._rttCanvas,
            "Round-trip time (ms)",
            this.rtt
        );

        this.createChart(
            "_packetLossChart",
            this._packetLossCanvas,
            "Packet Loss (%)",
            this.packetLoss
        );

        this.on(
            "rtt",
            (rtt) => {
                this.updateChart(this._rttChart, rtt);
            },
            { immediate: true }
        );

        this.on(
            "packetLoss",
            (packetLoss) => {
                this.updateChart(this._packetLossChart, packetLoss);
            },
            { immediate: true }
        );

        //----------------------SrtStats Modification-----------------------------//

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/WhepAudioServer.md");
        //----------------------Help Modal-----------------------------//
    }

    /**
     * Create a chart for displaying statistics.
     * @param {Object} _chart
     * @param {Object} canvas
     * @param {String} label
     * @param {Array} data
     */
    createChart(_chart, canvas, label, data) {
        this[_chart] = new Chart(canvas, {
            type: "line",
            labels: Array.from({ length: data.length }, (_, i) => i + 1),
            data: {
                datasets: [
                    {
                        label: label,
                        data: data,
                        borderColor: "#007F6A",
                        backgroundColor: "rgba(0, 127, 106, 0.2)",
                    },
                ],
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        min: 0,
                        beginAtZero: true,
                    },
                    x: {
                        ticks: {
                            maxTicksLimit: 10,
                        },
                    },
                },
            },
        });
    }

    /**
     * Update the chart with new data.
     * @param {Object} _chart
     * @param {Array} data
     */
    updateChart(_chart, data) {
        _chart.data.datasets[0].data = data;
        _chart.data.labels = Array.from(
            { length: data.length },
            (_, i) => i + 1
        );
        _chart.update();
    }
}
