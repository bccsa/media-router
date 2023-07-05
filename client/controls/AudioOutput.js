class AudioOutput extends _paAudioSinkBase {
    constructor() {
        super();
        this.formatHideRW = true;   // true = Disable Read Write audio format controls
        this.formatHideRO = false;  // true = Disable Read Only audio format controls
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <!-- Sink  -->
        <div class="w-full mb-2 mr-4">
            <label for="@{_sink}" class="form-label inline-block mb-2">Sink:</label>
            <select id="@{_sink}" class="paAudioBase-select" type="text" title="PulseAudio sink" value="@{sink}"></select>
        </div>
        `);
    }


    Init() {
        super.Init();

        // Populate input values
        this._parent.on('sinks', sinks => {
            // add new options
            sinks.forEach(sink => {
                if (![...this._sink.options].find(t => t.value == sink.name)) {
                    let o = document.createElement('option');
                    o.value = sink.name;
                    o.text = sink.description;
                    this._sink.options.add(o);
                }
            });

            // remove invalid options
            [...this._sink.options].forEach(option => {
                if (!sinks.find(t => t.name == option.value)) {
                    this._sink.options.remove(option.index);
                }
            });

            // Set index / sink
            let o = [...this._sink.options].find(t => t.value == this.sink);
            if (o) {
                this._sink.selectedIndex = o.index;
            } else {
                if (this._sink.selectedIndex >= 0) {
                    this.sink = this._sink.options[this._sink.selectedIndex].value;
                }
            }
        }, { immediate: true });
    }
}