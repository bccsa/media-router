let _paAudioSinkBase = require('./_paAudioSinkBase');

class AudioOutput extends _paAudioSinkBase {
    constructor() {
        super();
    }

    Init() {
        super.Init();

        this.on('sink', sink => {
            // Get the sink channel count
            if (this._parent._sinks[this.sink]) {
                this.channels = this._parent._sinks[this.sink].channels;
                this.sampleRate = this._parent._sinks[this.sink].sampleRate;
                this.bitDepth = this._parent._sinks[this.sink].bitDepth;
                this.ready = true;
            } else {
                this.ready = false;
            }
        }, { immediate: true });

        this._parent.on('sinks', () => {
            // Get the sink channel count
            if (this._parent._sinks[this.sink]) {
                this.channels = this._parent._sinks[this.sink].channels;
                this.sampleRate = this._parent._sinks[this.sink].sampleRate;
                this.bitDepth = this._parent._sinks[this.sink].bitDepth;
                this.ready = true
            } else {
                this.ready = false;
            }
        });
    }
}

module.exports = AudioOutput;