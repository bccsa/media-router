let _paAudioSourceBase = require('./_paAudioSourceBase');

class AudioInput extends _paAudioSourceBase {
    constructor() {
        super();
    }

    Init() {
        super.Init();
        
        this.on('source', source => {
            // Get the source channel count
            if (this._parent._sources[source]) {
                this.channels = this._parent._sources[source].channels;
                this.ready = true;
            } else {
                this.ready = false;
            }
        }, { immediate: true });

        this._parent.on('sources', () => {
            // Get / update the source channel count when a pulseAudio source is detected by the parent (Router)
            if (this._parent._sources[this.source]) {
                this.channels = this._parent._sources[this.source].channels;
                this.ready = true;
            } else {
                this.ready = false;
            }
        });
    }
}

module.exports = AudioInput;