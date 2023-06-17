let _paAudioSourceBase = require('./_paAudioSourceBase');

class AudioInput extends _paAudioSourceBase {
    constructor() {
        super();
        // Set audio format settings to read-only. These settings are read from the PulseAudio server, and cannot be modified by the user.
        this.SetAccess('channels', { Set: 'none'} );
        this.SetAccess('bitDepth', { Set: 'none'} );
        this.SetAccess('sampleRate', { Set: 'none'} );
    }

    Init() {
        super.Init();
        
        this.on('source', source => {
            // Get the source channel count
            if (this._parent._sources[source]) {
                this.channels = this._parent._sources[source].channels;
                this.sampleRate = this._parent._sources[source].sampleRate;
                this.bitDepth = this._parent._sources[source].bitDepth;
                this.ready = true;
            } else {
                this.ready = false;
            }
        }, { immediate: true });

        this._parent.on('sources', () => {
            // Get / update the source channel count when a pulseAudio source is detected by the parent (Router)
            if (this._parent._sources[this.source]) {
                this.channels = this._parent._sources[this.source].channels;
                this.sampleRate = this._parent._sources[this.source].sampleRate;
                this.bitDepth = this._parent._sources[this.source].bitDepth;
                this.ready = true;
            } else {
                this.ready = false;
            }
        });
    }
}

module.exports = AudioInput;