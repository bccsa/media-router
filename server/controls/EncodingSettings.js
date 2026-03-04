const util = require("util");
const exec = util.promisify(require("child_process").exec);

class EncodingSettings {
    constructor() {
        this.encoder = "x264enc";
        this.x264_speed_preset = "ultrafast";
        this.video_bitrate = "2M";
        this.video_gop = 30;
        this.video_quality = 720;
        this.video_framerate = 30;
        this.audio_bitrate = 96;
        this._available_x264enc = false;
        this._available_v4l2h264enc = false;
    }

    async InitEncodingSettings() {
        this._available_x264enc = await this.checkElementAvailability("x264enc");
        this._available_v4l2h264enc = await this.checkElementAvailability("v4l2h264enc");
    }

    /**
     * Calculate Module Video Bitrate
     */
    calcBitrate() {
        return parseInt(
            this.video_bitrate
                .toString()
                .replace("k", "000")
                .replace("M", "000000")
        );
    }

    /**
     * Check whether a GStreamer element is available on the system
     * @param {String} elementName
     * @returns {Boolean}
     */
    checkElementAvailability(elementName) {
        return new Promise((resolve) => {
            exec(`gst-inspect-1.0 | grep ${elementName}`, { silent: true })
                .then((data) => {
                    if (data.stderr)
                        this._parent._log(
                            "ERROR",
                            `${this._controlName} (${this.displayName}): ${data.stderr}`
                        );
                    if (data.stdout.length) resolve(true);
                    else resolve(false);
                })
                .catch((err) => {
                    this._parent._log(
                        "ERROR",
                        `${this._controlName} (${this.displayName}): ${err.message}`
                    );
                    resolve(false);
                });
        });
    }
}

module.exports = EncodingSettings;
