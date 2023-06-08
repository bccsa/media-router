let _paAudioBase = require('./_paAudioBase');

/**
 * PulseAudio Sink base module
 */
class _paAudioSinkBase extends _paAudioBase {
    constructor() {
        super();
        this.sink = "";   // PulseAudio sink name
    }

    Init() {
        super.Init();

        this.on('sink', sink => {
            // monitor is used for VU meter. For PulseAudio sinks, the monitor source is [sink].monitor.
            this.monitor = sink + '.monitor';
        });
    }
}

module.exports = _paAudioSinkBase;