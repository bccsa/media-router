let _paAudioSinkBase = require('./_paAudioSinkBase');

class AudioOutput extends _paAudioSinkBase {
    constructor() {
        super();
    }

    Init() {
        super.Init();

        this.on('sink', sink => {
            // Get the sink channel count
            if (this._parent._sinks[this.sink]) this.channels = this._parent._sinks[this.sink].channels;
        });

        this._parent.on('sinks', () => {
            // Get the sink channel count
            if (this._parent._sinks[this.sink]) this.channels = this._parent._sinks[this.sink].channels;
        });
    }
}

module.exports = AudioOutput;