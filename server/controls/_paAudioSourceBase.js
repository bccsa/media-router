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

            // Restart if running
            if (this.run) {
                this.run = false;
                setTimeout(() => {
                    if (this._parent.run) {
                        this.run = true;
                    }
                }, 500);
            }
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
                            if (!this.destinations.find(t => t == dst)) {
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

                    // Start / stop loopback controls
                    // ToDo: move logic to AudioLoopback to be able to self determine if source and destinations are ready before starting the loopback.
                    Object.values(this._controls).forEach(control => {
                        if (control.run != undefined) {
                            control.run = false;
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
        let loopbackName = this._controlName + '_loopback_' + dstName;
        let loopback = this[loopbackName];
        if (loopback) {
            loopback.run = false;
            this.Set({
                [loopbackName]: {
                    remove: true
                }
            });
        }

        delete this._destinations[dstName];
    }

}

module.exports = _paAudioSourceBase;