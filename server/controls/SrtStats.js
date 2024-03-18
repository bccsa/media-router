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
        this.receive_rate_mbps = 0;
        this.send_rate_mbps = 0;
        this.send_duration_us = 0;                  // send duration in us
        this.send_duration_s = 0;                   // send duration in seconds
        this.packet_loss = 0;                       // packetloss %
        this.MB_send_receive = 0;                   // total MB send / receive
        this.send_receive_rate = 0;                 // rate sending / receiving
        this.status = "disconnected";               // status: running/ disconnected
    }

    Init() {
        // reset values on intit
        this.status = "disconnected";

        // calc packet loss 
        this.on("packets_received_lost", () => {
            this.packet_loss = Math.round(this.packets_received_lost/ this.packets_received);  // 0 decimals
        })

        this.on("packets_sent_lost", () => {
            this.packet_loss = Math.round(this.packets_sent_lost/ this.packets_sent);  // 0 decimals
        })

        this.on("bytes_sent", () => {
            this.MB_send_receive = Math.round((this.bytes_sent/ 1000000 ) * 100) / 100;  // 2 decimals
        })

        this.on("bytes_received", () => {
            this.MB_send_receive = Math.round((this.bytes_received/ 1000000) * 100) / 100;  // 2 decimals
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

        this.on("send_duration_us", () => {
            this.send_duration_s = Math.round(this.send_duration_us/ 1000000);  // 0 decimals
        })
    }

}

module.exports = SrtStats;