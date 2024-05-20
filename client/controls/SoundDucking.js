class SoundDucking extends _paAudioSourceBase {
    constructor() {
        super();
        this.threshold = 60;        // level where to activate 
        this.ducking_level = 30;    // level to drop audio to
        this.attack = 20;           // attack in ms (time before ducking)
        this.attack_time = 20;      // attack time in ms (time to duck to 100%)
        this.release = 250;         // release in ms (time before release)
        this.release_time = 250;    // release time in ms (time to release 100%)

        // side chain
        this.side_chain = '';       // side_chain source
        this.side_chain_descr = ''; // Description of side_chain source
        this.channelMap = '1,2';
    
    }

    get html() {

        return super.html.replace('%additionalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- ----------------------------------------------------------    Gate Settings    ---------------------------------------------------------- -->

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Audio Ducking (Live Updates)</div>
        </div>

        <!-- side_chain  -->
            <div class="w-full mb-2">
                <label for="@{_side_chain}" class="form-label inline-block">Side Chain:</label>
                <select id="@{_side_chain}" class="paAudioBase-select" type="text" title="PulseAudio source" value="@{side_chain}"></select>
        </div>

        <!--    Channel Map      -->
        <div class="w-full mb-1 mr-4">
            <label for="@{_channelMap}" class="mb-2">Channel map: </label>
            <input id="@{_channelMap}" class="paAudioBase-text-area" type="text" maxlength="60"
            placeholder="Channel map (e.g. 1,2)" title="Enter channel map as a comma-separated list of channel numbers" value="@{channelMap}" />
        </div>

        <!--    threshold     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_threshold}" class="mt-5 w-1/6">Threshold:</label>
        
            <input id="@{_threshold}" class="paAudioBase-slider" type="range"
                title="Audio level % where the ducker should kick in" name="threshold" step="1" min="0" max="100" value="@{threshold}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_threshold}" step="1" min="0" max="100" value="@{threshold}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    ducking_level     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_ducking_level}" class="mt-5 w-1/6">Ducking Level:</label>
        
            <input id="@{_ducking_level}" class="paAudioBase-slider" type="range"
                title="Audio level % that the audio should be ducked to" step="1" min="0" max="100" value="@{ducking_level}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_ducking_level}" step="1" min="0" max="100" value="@{ducking_level}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    attack     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_attack}" class="mt-5 w-1/6">Attack:</label>
        
            <input id="@{_attack}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio need to above the threshold, before levels is ducked" step="1" min="0" max="2000" value="@{attack}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_attack}" step="1" min="0" max="2000" value="@{attack}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    attack_time     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_attack_time}" class="mt-5 w-1/6">Attack Time:</label>
        
            <input id="@{_attack_time}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio will take to duck" step="1" min="0" max="2000" value="@{attack_time}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_attack_time}" step="1" min="0" max="2000" value="@{attack_time}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    release     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_release}" class="mt-5 w-1/6">Release:</label>
        
            <input id="@{_release}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio need to below the threshold, before levels is restored" step="1" min="0" max="2000" value="@{release}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_release}" step="1" min="0" max="2000" value="@{release}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    release_time     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_release_time}" class="mt-5 w-1/6">Release Time:</label>
        
            <input id="@{_release_time}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio will take to restore to normal levels" step="1" min="0" max="2000" value="@{release_time}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_release_time}" step="1" min="0" max="2000" value="@{release_time}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        `);
    }

    Init() {
        super.Init();
        this.setHeaderColor('#cc8d72');

        // Populate input values
        this._parent.on('sources', sources => { this.updateSources(sources) }, { immediate: true });

        this.on("side_chain", m => {
            let _s = this._parent.sources.find(t => t.name == this.side_chain);
            if (_s) {
                this.side_chain_descr = _s.description; // save desicription of side_chain, to be used to rename side_chain when side_chain is disconnected
            }
            // update list of sources when side_chain is changed (to remove disconnected sources)
            this.updateSources(this._parent.sources);
        }, { immediate: true })

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SoundDucking.md');
        //----------------------Help Modal-----------------------------//
    }

    updateSources(sources) {
        // add new options
        sources.forEach(source => {
            let _s = [...this._side_chain.options].find(t => t.value == source.name);
            if (!_s) {
                let o = document.createElement('option');
                o.value = source.name;
                o.text = source.description;
                this._side_chain.options.add(o);
            } else if (_s.value == this.side_chain)  {
                _s.text = source.description;
            }
        });

        // remove invalid options
        [...this._side_chain.options].forEach(option => {
            let _s = sources.find(t => t.name == option.value)
            if (!_s && option.value != this.side_chain) {       // Remove removed input's && input is not the side_chain input (this is done to avoid input's changing when the device is not connected)
                this._side_chain.options.remove(option.index);
            } else if (!_s) {                               // If side_chain is removed, change name to disconnected
                option.text = this.side_chain_descr + " (disconnected)";
            }
        });

        // Set index / source
        let o = [...this._side_chain.options].find(t => t.value == this.side_chain);
        if (o) {
            this._side_chain.selectedIndex = o.index;
        } else {
            // add side_chain to the list, if it is not in the list 
            let o = document.createElement('option');
            o.value = this.side_chain;
            o.text = this.side_chain_descr + " (disconnected)";
            this._side_chain.options.add(o);
        }
    }
}