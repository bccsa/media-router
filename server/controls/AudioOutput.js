let _paAudioSinkBase = require('./_paAudioSinkBase');

class AudioOutput extends _paAudioSinkBase {
    constructor() {
        super();
        // Set audio format settings to read-only. These settings are read from the PulseAudio server, and cannot be modified by the user.
        this.SetAccess('channels', { Set: 'none' });
        this.SetAccess('bitDepth', { Set: 'none' });
        this.SetAccess('sampleRate', { Set: 'none' });
    }

    Init() {
        super.Init();

        this.on('sink', sink => {
            // Set ready to false on source change to prompt AudioLoopback controls to disconnect.
            this.ready = false;

            setTimeout(() => {
                // Validate sink
                if (this._parent._sinks[sink]) {
                    this.channels = this._parent._sinks[sink].channels;
                    this.sampleRate = this._parent._sinks[sink].sampleRate;
                    this.bitDepth = this._parent._sinks[sink].bitDepth;
                    this.ready = true;
                }
            }, 500);
        }, { immediate: true });

        this._parent.on('sinks', () => {
            // Get / update the sink format settings when a pulseAudio sink is detected by the parent (Router)
            if (this._parent._sinks[this.sink]) {
                this.channels = this._parent._sinks[this.sink].channels;
                this.sampleRate = this._parent._sinks[this.sink].sampleRate;
                this.bitDepth = this._parent._sinks[this.sink].bitDepth;
                this.ready = true
            } else {
                this.ready = false;
            }
        }, { immediate: true });
    }
}

module.exports = AudioOutput;