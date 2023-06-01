let _paAudioModule = require('_paAudioModule');

class AudioInput extends _paAudioModule {
    constructor() {
        super();
        this.source = ""; // PulseAudio source
        this.sourceDescription = "";
    }

    Init() {
        // Set monitor source (from inherited _paAudioModule) to source
        this.on('source', val => {
            this.monitor = val;
        });
    }
}

module.exports = AudioInput;