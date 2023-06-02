let _paAudioModule = require('./_paAudioModule');

class AudioOutput extends _paAudioModule {
    constructor() {
        super();
        this.sink = ""; // PulseAudio sink name
    }

    Init() {
        super.Init();

        this.on('sink', sink => {
            // monitor is used for VU meter. For PulseAudio sinks, the monitor source is a separate source named [source].monitor.
            this.monitor = sink + '.monitor';

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