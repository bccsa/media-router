class AudioInput extends _paAudioSourceBase {
    constructor() {
        super();
        this.formatHideRW = true;   // true = Disable Read Write audio format controls
        this.formatHideRO = false;  // true = Disable Read Only audio format controls
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <div class="w-full mb-1 flex">
            <!-- Source  -->
            <div class="w-full mb-2">
                <label for="@{_source}" class="form-label inline-block mb-2">Source:</label>
                <select id="@{_source}" class="paAudioBase-select" type="text" title="PulseAudio source" value="@{source}"></select>
            </div>
        </div>
        `);
    }

 
    Init() {
        super.Init();
        this.setHeaderColor('#012F74');

        // Populate input values
        this._parent.on('sources', sources => {
            // add new options
            sources.forEach(source => {
                if (![...this._source.options].find(t => t.value == source.name)) {
                    let o = document.createElement('option');
                    o.value = source.name;
                    o.text = source.description;
                    this._source.options.add(o);
                }
            });

            // remove invalid options
            [...this._source.options].forEach(option => {
                if (!sources.find(t => t.name == option.value)) {
                    this._source.options.remove(option.index);
                }
            });

            // Set index / source
            let o = [...this._source.options].find(t => t.value == this.source);
            if (o) {
                this._source.selectedIndex = o.index;
            } else {
                if (this._source.selectedIndex >= 0) {
                    this.source = this._source.options[this._source.selectedIndex].value;
                }
            }
        }, { immediate: true });
    }
}