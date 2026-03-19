const _ristBase = require("./_ristBase");
const { url, parseStats, senderStats } = require("./RIST/rist");

class SrtToRist extends _ristBase {
    constructor() {
        super();
        this.buffer = 75;
        this._srtElementName = "SrtToRist";
    }

    _buildPipeline() {
        return (
            `srtserversrc uri="${this.uri()}" wait-for-connection=false name="${this._srtElementName}" ! ` +
            `udpsink port=${this.udpSocket} host=127.0.0.1`
        );
    }

    _buildRistCmd() {
        return `ristsender --buffer ${this.buffer} -i udp://127.0.0.1:${this.udpSocket} -o "${url(this._controls)}"`;
    }

    _ristStartOrder() {
        return "srt-first";
    }

    _parseStats(_d) {
        return senderStats(parseStats(_d));
    }
}

module.exports = SrtToRist;
