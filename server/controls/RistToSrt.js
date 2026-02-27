const _ristBase = require("./_ristBase");
const { url, parseStats, receiverStats } = require("./RIST/rist");

class RistToSrt extends _ristBase {
    constructor() {
        super();
        this._srtElementName = "RistToSrt";
    }

    _buildPipeline() {
        return (
            `udpsrc port=${this.udpSocket} address=127.0.0.1 ! ` +
            `srtserversink uri="${this.uri()}" wait-for-connection=false name="${this._srtElementName}" sync=false`
        );
    }

    _buildRistCmd() {
        return `ristreceiver -i "${url(this._controls)}" -o udp://127.0.0.1:${this.udpSocket} `;
    }

    _ristStartOrder() {
        return "rist-first";
    }

    _parseStats(_d) {
        return receiverStats(parseStats(_d));
    }
}

module.exports = RistToSrt;
