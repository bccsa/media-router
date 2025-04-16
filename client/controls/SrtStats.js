class SrtStats extends ui {
    constructor() {
        super();
        // Parents div for srtStats
        this.parentElement = "_SrtStatsDiv";
        this.StatsName = "";
        this.rtt_ms = 0;
        this.rtt_ms_rounded = 0;
        this.available_bandwidth = 0;
        this.available_bandwidth_rounded = 0;
        this.bytes_received = 0;
        this.bytes_sent = 0;
        this.packets_received = 0;
        this.packets_received_lost = 0;
        this.packets_sent = 0;
        this.packets_sent_lost = 0;
        this.receive_rate_mbps = 0;
        this.send_rate_mbps = 0;
        this.send_duration_us = 0; // send duration in us
        this.send_duration = "0s"; // send duration in seconds
        this.packet_loss = 0; // packetloss %
        this.MB_send_receive = 0; // total MB send / receive
        this.send_receive_rate = 0; // rate sending / receiving
        this.status = "disconnected"; // status: running/ disconnected
    }

    get html() {
        return `
        <!-- SRT Controls div -->
        <div class="text-sm text-left grid grid-cols-8">
            <div class="border px-4 py-2">
             <span>@{StatsName}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{send_receive_rate}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{packet_loss}</span>%
            </div>
            <div class="border px-4 py-2">
                <span>@{MB_send_receive}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{rtt_ms_rounded}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{available_bandwidth_rounded}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{send_duration}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{status}</span>
            </div>
        </div>
        `;
    }

    Init() {
        this.on(
            "status",
            (status) => {
                if (this._parent.srtMode == "caller")
                    this._parent._SrtConnectionStat(status);
            },
            { immediate: true }
        );
    }
}
