/**
 * Srt statistics module
 */

let { dm } = require('../modular-dm');

class SrtStats extends dm {
    constructor() {
        super();
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
        this.packets_send_recieve = 0;              // total packets send / received
        this.receive_rate_mbps = 0;
        this.send_rate_mbps = 0;
        this.send_duration_us = 0;                  // send duration in us
        this.send_duration = "0s";                   // send duration in seconds
        this.packet_loss = 0;                       // packetloss %
        this._pl_packet_loss = 0;                   // bytes lost
        this._pl_sampleCount = 5;                   // number of samples to use to create running avg
        this._pl_prev_loss = 0;                     // previous packet loss value
        this._pl_prev = 0                           // previous total bytes
        this._sma = [];                             // simple moving average
        this.MB_send_receive = 0;                   // total MB send / receive
        this.send_receive_rate = 0;                 // rate sending / receiving
        this.status = "disconnected";               // status: running/ disconnected
    }

    Init() {
        // reset values on intit
        this.status = "disconnected";

        // calc packet loss 
        this.on("packets_received_lost", (val) => {
            this._pl_packet_loss = val;
        })

        this.on("packets_sent_lost", (val) => {
            this._pl_packet_loss = val;
        })

        this.on("packets_received", (val) => {
            this.packets_send_recieve = val;
        })

        this.on("packets_sent", (val) => {
            this.packets_send_recieve = val;
        })

        this.on("bytes_sent", (val) => {
            this.MB_send_receive = Math.round((val/ 1000000 ) * 100) / 100;  // 2 decimals
        })

        this.on("bytes_received", (val) => {
            this.MB_send_receive = Math.round((val/ 1000000) * 100) / 100;  // 2 decimals
        })

        this.on("send_rate_mbps", () => {
            this.send_receive_rate = Math.round((this.send_rate_mbps) * 100) / 100;  // 2 decimals
        })

        this.on("receive_rate_mbps", () => {
            this.send_receive_rate = Math.round((this.receive_rate_mbps) * 100) / 100;  // 2 decimals
        })

        this.on("rtt_ms", () => {
            this.rtt_ms_rounded = Math.round((this.rtt_ms) * 100) / 100;  // 2 decimals
        })

        this.on("available_bandwidth", () => {
            this.available_bandwidth_rounded = Math.round((this.available_bandwidth) * 100) / 100;  // 2 decimals
        })

        this.on("send_duration_us", (val) => {
            var _res = "";
            var seconds = parseInt(val / 1000000, 10);
            var days = Math.floor(seconds / (3600*24));
            seconds  -= days*3600*24;
            var hrs   = Math.floor(seconds / 3600);
            seconds  -= hrs*3600;
            var mnts = Math.floor(seconds / 60);
            seconds  -= mnts*60;

            if (days > 0) { _res += days+"D " };
            if (hrs > 0 || days > 0) { _res += hrs+"H " };
            if (mnts > 0 || hrs > 0 || days > 0) { _res += mnts+"M " };
            _res += seconds + "s";
            this.send_duration = _res;
        })

        // calculate exponential moving avarage srt stats
        this.on("packets_send_recieve", () => {
            setTimeout(() => {
                if (this._pl_prev > this.packets_send_recieve || this._pl_prev < 0) { this._pl_prev = 0 };
                if (this._pl_prev_loss > this._pl_packet_loss || this._pl_prev_loss < 0) { this._pl_prev_loss = 0 };

                let _pl_smaple = this.packets_send_recieve - this._pl_prev;
                let _pl_smaple_pl = this._pl_packet_loss - this._pl_prev_loss;

                if (this._sma.length > this._pl_sampleCount) { this._sma.shift(); };
                this._sma.push([_pl_smaple, _pl_smaple_pl])

                let _t_pl = 0;  // total packet loss in sma
                let _t = 0;     // total packets in sma

                this._sma.forEach(val => {
                    _t += val[0];
                    _t_pl += val[1];
                })

                this.packet_loss = Math.round((_t_pl / _t) * 100);

                this._pl_prev = this.packets_send_recieve;
                this._pl_prev_loss = this._pl_packet_loss;
            },1022)
        })
    }

}

module.exports = SrtStats;