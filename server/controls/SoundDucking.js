const _paNullSinkBase = require('./_paNullSinkBase');
const vuMeter = require('./vuMeter');
const path = require('path');

const vu = new vuMeter();

class SoundDucking extends _paNullSinkBase {
    constructor() {
        super();
        this.threshold = 60;        // level where to activate 
        this.ducking_level = 30;    // level to drop audio to
        this.attack = 20;           // attack in ms (time before ducking)
        this.attack_time = 20;      // attack time in ms (time to duck to 100%)
        this.release = 250;         // release in ms (time before release)
        this.release_time = 250;    // release time in ms (time to release 100%)
        this._attack = false;
        this._release = true;
        this._ducked = false;
        this._threshold = 0;

        // timers 
        this._attackTimer = undefined;
        this._releaseTimer = undefined;
        this._attackInterval = undefined;
        this._releaseInterval = undefined;
        this._currentVol = this.volume;

        // side chain
        this.side_chain = "";       // chain to listen on
        this.channelMap = '';
    }

    Init() {
        super.Init();
        vu.Init(this);

        this.on('ready', ready => {
            vu.ready = ready;
            if (ready) {
                this._map();
                this._parent.PaCmdQueue(() => {
                    this._startAudioDucker();
                });
            }
        });

        this.on('run', run => {
            vu.run = run;
            if (!run) {
                this._parent.PaCmdQueue(() => {
                    this._stopAudioDucker();
                });
            }
        });

        this.on('side_chain', () => {
            this._map();
        });

        this.on('channelMap', () => {
            this._map();
        });

        this.on('threshold', val => {
            this._threshold = (val / 100 * 60) -60; // offset with -60 to make a negative
        }, { immediate: true })
    }

    /**
     * Calculates and sets this.channels and this._channelMap from this.channelMap
     */
    _map() {
        if (this._parent._sources[this.side_chain]) {
            let _srcChannels = this._parent._sources[this.side_chain].channels;
            let _srcChannelMap = this._parent._sources[this.side_chain].channelmap;

            let masterMap = [];
            let channelCount = 0;
            let channelMap = [];

            this.channelMap.split(',').forEach(channel => {
                let ch = parseInt(channel);
                if (ch && ch > 0 && ch <= _srcChannels) {
                    masterMap.push(_srcChannelMap[ch - 1]);
                    channelMap.push(ch);
                    channelCount++;
                }
            });

            // Reduce channel count if larger than side_chain channel count
            if (channelCount > _srcChannels) {
                channelCount = _srcChannels;
                channelMap.splice(channelCount);
            }

            if (channelCount > 0) {
                this.channelMap = channelMap.join(',');
            } else {
                // Create default channel map
                channelMap = [];
                for (let i = 1; i <= _srcChannels; i++) {
                    channelMap.push(i);
                }
                this.channelMap = channelMap.join(',');

                // Regenerate map
                this._map();
            }
        }
    }

    _startAudioDucker() {
        if (this.side_chain) {
            this._parent._log('INFO', `${this._paModuleName} (${this.displayName}): Starting Audio Ducker`);
            const _pl = `pulsesrc device=${this.side_chain} ! audio/x-raw,rate=${this.sampleRate},format=S${this.bitDepth}LE,channels=1 ! audioconvert mix-matrix="<<${this.channelMap}>>" ! queue ! level peak-falloff=120 peak-ttl=50000000 interval=${this.vuInterval * 1000000} ! fakesink silent=true`;
            const _path = `${path.dirname(process.argv[1])}/child_processes/vu_child.js`;
            vu.start_vu(_path, [_pl, "audioLevel"]);
            // start vu
            this.on("audioLevel", (data) => {
                if (data && data.decay_dB) {
                    let val = data.decay_dB[0];

                    if (val >= this._threshold) {
                        if (!this._attack) {
                            this._startAttackTimer();
                            this._stopReleaseTimer();
                        }
                        this._attack = true;
                        this._release = false;
                    } 
                    else {
                        if (!this._release) {
                            this._startReleaseTimer();
                            this._stopAttackTimer();
                        }
                        this._attack = false;
                        this._release = true;
                    }
                }
            })    
        } else {
            this._parent._log('FATAL', `${this._paModuleName} (${this.displayName}): Unable to start Audio Ducker, Side chain device is not available`);
        }  
    }

    _stopAudioDucker() {
        this._parent._log('INFO', `${this._paModuleName} (${this.displayName}): Stopping Audio Ducker`);
        vu.stop_vu();
    }

    _startAttackTimer() {
        this._attackTimer = setTimeout(this._setDuckingVol.bind(this), this.attack);
    }

    _stopAttackTimer() {
        if (this._attackTimer)
            clearTimeout(this._attackTimer);
        this._attackTimer = undefined;
    }

    _startReleaseTimer() {
        this._releaseTimer = setTimeout(this._restoreVol.bind(this), this.release)
    }

    _stopReleaseTimer() {
        if (this._releaseTimer)
            clearTimeout(this._releaseTimer);
        this._releaseTimer = undefined;
    }

    _setDuckingVol() {
        if (!this._ducked) {
            // stop release interval
            if (this._releaseInterval) {
                clearInterval(this._releaseInterval);
                this._releaseInterval = undefined; 
            }

            this._ducked = true;
            let end_vol = this.ducking_level / this.volume * 100;
            let hops = Math.round(this.attack_time / 100);
            if (hops < 5) hops = 5; // cap min hops
            let step = (this._currentVol - end_vol) /hops;
            this._attackInterval = setInterval(() => {
                if (this._currentVol > end_vol) {   // decreasing
                    this._currentVol -= step;
                    this._setVolume(this._currentVol);
                } 
                else {
                    clearInterval(this._attackInterval);
                    this._setVolume(end_vol);
                    this._attackInterval = undefined;
                }
            }, this.attack_time / hops);
        }
    }

    _restoreVol() {
        if (this._ducked) {
            // stop attack interval
            if (this._attackInterval) {
                clearInterval(this._attackInterval);
                this._attackInterval = undefined; 
            }

            this._ducked = false;
            let end_vol = this.volume;
            let hops = Math.round(this.release_time / 100);
            if (hops < 5) hops = 5; // cap min hops
            let step = (end_vol - this._currentVol) /hops;
            this._releaseInterval = setInterval(() => {
                if (this._currentVol < end_vol) {   // increasing
                    this._currentVol += step;
                    this._setVolume(this._currentVol);
                } 
                else {
                    clearInterval(this._releaseInterval);
                    this._setVolume(end_vol);
                    this._releaseInterval = undefined;
                }
            }, this.release_time / hops);
        }
    }

}

module.exports = SoundDucking;