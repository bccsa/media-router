let _paAudioBase = require('./_paAudioBase');

/**
 * PulseAudio Source base module
 */
class _paAudioSourceBase extends _paAudioBase {
    constructor() {
        super();
        this.source = "";   // PulseAudio source name
        this.destinations = []; // Destination control names array
        this._destinations = {};

        // Event handler for destination remove event.
        this._dstRemoveHandler = function (dst) {
            this._removeDestination(dst._controlName);
        }.bind(this);
    }

    Init() {
        super.Init();

        this.on('source', source => {
            // monitor is used for VU meter. For PulseAudio sources, the monitor source is the same as the actual source.
            this.monitor = source;
        }, { immediate: true });

        // Add / remove loopback controls on first run. Doing this immediately at startup does 
        // not work as the destination control(s) may not have been created yet.
        let destConf = function () {
            this.on('destinations', destinations => {
                // remove destinations
                Object.keys(this._destinations).forEach(dst => {
                    if (!destinations.find(t => t == dst)) {
                        this._removeDestination(dst);
                    }
                });
    
                // add destinations
                destinations.forEach(dst => {
                    if (!this._destinations[dst]) {
                        this._addDestination(dst);
                    }
                });
            }, { immediate: true });
        }.bind(this);
        
        if (this.run) {
            destConf();
        } else {
            this.once('run', () => {
                destConf();
            });
        }

        // Start/stop child loopback controls
        this.on('run', run => {
            Object.values(this._controls).forEach(c => {
                c.run = run;
            });
        });

        // Remove all destinations if this control is removed
        this.on('remove', () => {
            this.destinations = [];
        });
    }

    _addDestination(dstName) {
        let dest = this._parent[dstName];

        if (dest) {
            // Create loopback child control to link this control's PulseAudio source to the destination controls PulseAudio sink
            this.Set({
                [this._paModuleName + '_loopback_' + dstName]: {
                    controlType: 'AudioLoopback',
                    srcControl: this._controlName,
                    dstControl: dest._controlName,
                    run: this.run,
                }
            });

            this._destinations[dstName] = true;

            // Subscribe to destination control remove event to automatically clear source control's destination
            dest.once('remove', this._dstRemoveHandler, { caller: this });
        } else {
            console.log(`${this._controlName} (${this.displayName}): Unable to add loopback - destination control "${dstName}" not found.`)
        }
    }

    _removeDestination(dstName) {
        let loopbackName = this._paModuleName + '_loopback_' + dstName;
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

        // Update destinations property
        this.destinations = Object.keys(this._destinations);

        // Unsubscribe from destination remove event
        let dest = this._parent[dstName];
        if (dest) {
            dest.off('remove', this._dstRemoveHandler);
        }
    }

}

module.exports = _paAudioSourceBase;