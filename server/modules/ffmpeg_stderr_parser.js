const event = require('events');

/**
 * Parser for parsing ffmpeg console output (stderr output).
 */
class ffmpeg_stderr_parser extends event {
    /**
     * Parser for parsing ffmpeg console output (stderr output).
     */
    constructor() {
        super();
        this.bitrate = 0;
    }

    /**
     * Set ffmpeg stderr string.
     * Changes are notified through the following events:
     * bitrate: includes the updated bitrate value in bits/s
     */
    Set(log) {
        this._parseBitrate(log);
    }

    _parseBitrate(log) {
        let m = [...log.matchAll(/bitrate=[ ]*([0-9|.]*)([a-z])bits\/s/gmi)];
        let match;
        if (m.length >= 1) match = m[0];

        if (match && match.length >= 3) {
            let bitrate = parseFloat(match[1]);
            let multiplier = match[2];

            if (typeof bitrate == 'number') {
                let validMultiplier = false;
                if (multiplier == 'k') {
                    validMultiplier = true;
                    bitrate *= 1000;
                } else if (multiplier == 'M') {
                    bitrate *= 1000000;
                    validMultiplier = true;
                }

                if (validMultiplier && bitrate != this.bitrate) {
                    this.bitrate = bitrate;
                    this.emit('bitrate', bitrate);
                }
            }
        }
    }
}

module.exports.ffmpeg_stderr_parser = ffmpeg_stderr_parser;