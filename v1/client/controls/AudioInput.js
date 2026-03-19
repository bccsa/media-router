class AudioInput extends _paAudioSourceBase {
    constructor() {
        super();
        this.formatHideRW = true;   // true = Disable Read Write audio format controls
        this.formatHideRO = false;  // true = Disable Read Only audio format controls
        this.master = '';           // Master source used by the PulseAudio module-remap-source module.
        this.master_descr = '';     // Description of master source
        this.channelMap = '1,2';
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <div class="w-full mb-1">
            <!-- Source  -->
            <div class="w-full mb-2">
                <label for="@{_source}" class="form-label inline-block">Source:</label>
                <select id="@{_source}" class="paAudioBase-select" type="text" title="PulseAudio source" value="@{master}"></select>
            </div>

            <!--    Channel Map      -->
            <div class="w-full mb-1 mr-4">
                <label for="@{_channelMap}" class="mb-2">Channel map: </label>
                <input id="@{_channelMap}" class="paAudioBase-text-area" type="text" maxlength="60"
                placeholder="Channel map (e.g. 1,2)" title="Enter channel map as a comma-separated list of channel numbers" value="@{channelMap}" />
            </div>

        </div>
        `);
    }

 
    Init() {
        super.Init();
        this.setHeaderColor('#012F74');

        // Populate input values
        this._parent.on('sources', sources => { this.updateSources(sources) }, { immediate: true });

        this.on("master", m => {
            let _s = this._parent.sources.find(t => t.name == this.master);
            if (_s) {
                this.master_descr = _s.description; // save desicription of master, to be used to rename master when master is disconnected
            }
            // update list of sources when master is changed (to remove disconnected sources)
            this.updateSources(this._parent.sources);
        }, { immediate: true })

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/AudioInput.md');
        //----------------------Help Modal-----------------------------//
    }

    updateSources(sources) {
        // add new options
        sources.forEach(source => {
            let _s = [...this._source.options].find(t => t.value == source.name);
            if (!_s) {
                let o = document.createElement('option');
                o.value = source.name;
                o.text = source.description;
                this._source.options.add(o);
            } else if (_s.value == this.master)  {
                _s.text = source.description;
            }
        });

        // remove invalid options
        [...this._source.options].forEach(option => {
            let _s = sources.find(t => t.name == option.value)
            if (!_s && option.value != this.master) {       // Remove removed input's && input is not the master input (this is done to avoid input's changing when the device is not connected)
                this._source.options.remove(option.index);
            } else if (!_s) {                               // If master is removed, change name to disconnected
                option.text = this.master_descr + " (disconnected)";
            }
        });

        // Set index / source
        let o = [...this._source.options].find(t => t.value == this.master);
        if (o) {
            this._source.selectedIndex = o.index;
        } else {
            // add master to the list, if it is not in the list 
            let o = document.createElement('option');
            o.value = this.master;
            o.text = this.master_descr + " (disconnected)";
            this._source.options.add(o);
        }
    }
}