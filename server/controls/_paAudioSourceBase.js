let _paAudioBase = require('./_paAudioBase');

/**
 * PulseAudio Source base module
 */
class _paAudioSourceBase extends _paAudioBase {
    constructor() {
        super();
        this.source = "";   // PulseAudio source name
        this.destinations = []; // Destination module names array
        this._destinations = {};
    }

    Init() {
        super.Init();

        this.on('source', source => {
            // monitor is used for VU meter. For PulseAudio sources, the monitor source is the same as the actual source.
            this.monitor = source;
        }, { immediate: true });

        // Set running status on child controls (AudioLoopBack controls)
        let init;
        this.on('ready', ready => {
            if (ready && !init) {
                this.on('run', run => {

                    // Add / remove loopback controls
                    if (run) {
                        // remove destinations
                        Object.keys(this._destinations).forEach(dst => {
                            if (!this.destinations.find(dst)) {
                                this._removeDestination(dst);
                            }
                        });

                        // add destinations
                        this.destinations.forEach(dst => {
                            if (!this._destinations[dst]) {
                                this._addDestination(dst);
                            }
                        });
                    }

                    Object.values(this._controls).forEach(control => {
                        if (control.run != undefined) {
                            control.run = run;
                        }
                    });
                }, { immediate: true });
                init = true;
            }

            if (!ready) {
                this.run = false;
            }
        });
    }

    _addDestination(dstName) {
        let dest = this._parent[dstName];

        if (this.ready && dest) {
            // Function to link source with destination with PulseAudio Loopback module
            function link(parent) {
                // Set control running status after creation
                parent.once(parent._controlName + '_loopback_' + dstName, control => {
                    control.run = parent.run;
                });

                // Create loopback child control to link this control's PulseAudio source to the destination controls PulseAudio sink
                parent.Set({
                    [parent._controlName + '_loopback_' + dstName]: {
                        controlType: 'AudioLoopback',
                        channels: parent.channels,
                        source: parent.source,
                        sink: dest.sink,
                        hideData: true,
                    }
                });

                parent._destinations[dstName] = true;
            }

            if (dest.ready) {
                // Link immediately if the destination is ready
                link(this);
            } else {
                // Else wait for the destination to become ready before linking
                dest.once('ready', ready => {
                    link(this);
                });
            }
        }
    }

    _removeDestination(dstName) {
        let loopback = this[this._controlName + '_loopback_' + dstName];
        if (loopback) {
            loopback.run = false;
            this.Set({
                ['loopback_' + dest]: {
                    remove: true
                }
            });
        }

        delete this._destinations[dstName];
    }

}

module.exports = _paAudioSourceBase;