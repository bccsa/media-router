class RistStats extends ui {
    constructor() {
        super();
        // Parents div for srtStats
        this.parentElement = "_RistStatsDiv";
        this.id = 0;
        this.cname = "";
        this.bitrate = 0;
        this.packetLoss = "NA";
        this.quality = 0;
        this.rtt = 0;
        this.status = "disconnected"; // status: running/ disconnected
    }

    get html() {
        return `
        <!-- SRT Controls div -->
        <div class="text-sm text-left grid grid-cols-7">
            <div class="border px-4 py-2">
             <span>@{id}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{cname}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{bitrate}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{packetLoss}</span>%
            </div>
            <div class="border px-4 py-2">
                <span>@{quality}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{rtt}</span>
            </div>
            <div class="border px-4 py-2">
                <span>@{status}</span>
            </div>
        </div>
        `;
    }

    Init() {}
}
