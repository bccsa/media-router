const SVE = require("controls/GstWhepServer/html");

class GstWhepServer extends _paAudioSinkBase {
    constructor() {
        super();
        this.port = 9090 // Default port for WHEP server
        this.opusFec = false; // Enable Opus Forward Error Correction 
        this.opusFecPacketLoss = 5; // Opus FEC packet loss percentage (preset value)
        this.opusComplexity = 10; // Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.opusBitrate = 64; // Opus encoding target bitrate in kbps
        this.opusFrameSize = 20; // Opus frame size
        this.rtpRed = false; // Enable RED (Redundant Encoding Data) for Opus
        this.rtpRedDistance = 2; // RTP RED distance (0: disable)
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
            ${SVE.html()}
        `);
    }


    Init() {
        super.Init();
        this.setHeaderColor('#007F6A');

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        // this._loadHelpMD('controls/GstWhepServer.md');
        //----------------------Help Modal-----------------------------//
    }

}