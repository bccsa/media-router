let _paAudioModule = require('./_paAudioModule');

class AudioInput extends _paAudioModule {
    constructor() {
        super();
        this.source = ""; // PulseAudio source name
    }

    Init() {
        super.Init();

        this.on('source', source => {
            // monitor is used for VU meter. For PulseAudio sources, the monitor source is the same as the actual source.
            this.monitor = source;

            // Get the source channel count
            if (this._parent._sources[this.source]) this.channels = this._parent._sources[this.source].channels;
        });

        this._parent.on('sources', () => {
            // Get the source channel count
            if (this._parent._sources[this.source]) this.channels = this._parent._sources[this.source].channels;
        });
    }
}

module.exports = AudioInput;