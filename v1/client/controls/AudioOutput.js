class AudioOutput extends _paAudioSinkBase {
    constructor() {
        super();
        this.formatHideRW = true;   // true = Disable Read Write audio format controls
        this.formatHideRO = false;  // true = Disable Read Only audio format controls
        this.master = '';           // Master sink used by the PulseAudio module-remap-sink module.
        this.master_descr = '';     // Description of master sink
        this.channelMap = '1,2';
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <!-- Sink  -->
        <div class="w-full mb-2 mr-4">
            <label for="@{_sink}" class="form-label inline-block mb-2">Sink:</label>
            <select id="@{_sink}" class="paAudioBase-select" type="text" title="PulseAudio sink" value="@{master}"></select>
        </div>

        <!--    Channel Map      -->
        <div class="w-full mb-1 mr-4">
            <label for="@{_channelMap}" class="mb-2">Channel map: </label>
            <input id="@{_channelMap}" class="paAudioBase-text-area" type="text" maxlength="60"
            placeholder="Channel map (e.g. 1,2)" title="Enter channel map as a comma-separated list of channel numbers" value="@{channelMap}" />
        </div>
        `);
    }


    Init() {
        super.Init();
        this.setHeaderColor('#007F6A');

        // Populate input values
        this._parent.on('sinks', sinks => { this.updateSinks(sinks) }, { immediate: true });

        this.on("master", m => {
            let _s = this._parent.sinks.find(t => t.name == m);
            if (_s) {
                this.master_descr = _s.description; // save desicription of master, to be used to rename master when master is disconnected
            }
            // update list of sinks when master is changed (to remove disconnected sinks)
            this.updateSinks(this._parent.sinks);
        }, { immediate: true })

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/AudioOutput.md');
        //----------------------Help Modal-----------------------------//
    }

    /**
     * Update list of sinks
     */
    updateSinks(sinks) {
        // add new options
        sinks.forEach(sink => {
            let _s = [...this._sink.options].find(t => t.value == sink.name);
            if (!_s) {
                let o = document.createElement('option');
                o.value = sink.name;
                o.text = sink.description;
                this._sink.options.add(o);
            } else if (_s.value == this.master) { // renmae master's description, master is connected again
                _s.text = sink.description;
            }
        });

        // remove invalid options
        [...this._sink.options].forEach(option => {
            let _s = sinks.find(t => t.name == option.value)
            if (!_s && option.value != this.master) {       // Remove removed input's && input is not the master input (this is done to avoid input's changing when the device is not connected)
                this._sink.options.remove(option.index);
            } else if (!_s) {                               // If master is removed, change name to disconnected
                option.text = this.master_descr + " (disconnected)";
            }
        });

        // Set index / sink
        let o = [...this._sink.options].find(t => t.value == this.master);
        if (o) {
            this._sink.selectedIndex = o.index;
        } else {
            // add master to the list, if it is not in the list 
            let o = document.createElement('option');
            o.value = this.master;
            o.text = this.master_descr + " (disconnected)";
            this._sink.options.add(o);
        }               
    }
}