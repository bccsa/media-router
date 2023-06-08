let _paAudioBase = require('./_paAudioBase');

/**
 * PulseAudio Source base module
 */
class _paAudioSourceBase extends _paAudioBase {
    constructor() {
        super();
        this.source = "";   // PulseAudio source name
    }

    Init() {
        super.Init();

        this.on('source', source => {
            // monitor is used for VU meter. For PulseAudio sources, the monitor source is the same as the actual source.
            this.monitor = source;
        });
    }
}

module.exports = _paAudioSourceBase;