let _paAudioBase = require('./_paAudioBase');

class _paAudioSourceBase extends _paAudioBase {
    constructor() {
        super();
        this.source = "";   // PulseAudio module-null-sink source name (xxx.monitor)
    }

    Init() {
        super.Init();

        this.on('source', source => {
            this.monitor = source;
        });
    }
}

module.exports = _paAudioSourceBase;