const _SD = require("controls/SoundDucking/html");

class SoundDucking extends _paAudioSourceBase {
    constructor() {
        super();
        this.threshold = 60; // level where to activate
        this.ducking_level = 30; // level to drop audio to
        this.attack = 20; // attack time in ms (time to duck to 100%)
        this.hold = 250; // hold in ms (time before release)
        this.release = 250; // release time in ms (time to release 100%)

        // side chain
        this.side_chain = ""; // side_chain source
        this.side_chain_descr = ""; // Description of side_chain source
        this.channelMap = "";
    }

    get html() {
        return super.html.replace("%additionalHtml%", _SD.html());
    }

    Init() {
        super.Init();
        this.setHeaderColor("#cc8d72");

        // Populate input values
        this._parent.on(
            "sources",
            (sources) => {
                this.updateSources(sources);
            },
            { immediate: true }
        );

        this.on(
            "side_chain",
            (m) => {
                let _s = this._parent.sources.find(
                    (t) => t.name == this.side_chain
                );
                if (_s) {
                    this.side_chain_descr = _s.description; // save desicription of side_chain, to be used to rename side_chain when side_chain is disconnected
                }
                // update list of sources when side_chain is changed (to remove disconnected sources)
                this.updateSources(this._parent.sources);
            },
            { immediate: true }
        );

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/SoundDucking.md");
        //----------------------Help Modal-----------------------------//
    }

    updateSources(sources) {
        // add new options
        sources.forEach((source) => {
            let _s = [...this._side_chain.options].find(
                (t) => t.value == source.name
            );
            if (!_s) {
                let o = document.createElement("option");
                o.value = source.name;
                o.text = source.description;
                this._side_chain.options.add(o);
            } else if (_s.value == this.side_chain) {
                _s.text = source.description;
            }
        });

        // remove invalid options
        [...this._side_chain.options].forEach((option) => {
            let _s = sources.find((t) => t.name == option.value);
            if (!_s && option.value != this.side_chain) {
                // Remove removed input's && input is not the side_chain input (this is done to avoid input's changing when the device is not connected)
                this._side_chain.options.remove(option.index);
            } else if (!_s) {
                // If side_chain is removed, change name to disconnected
                option.text = this.side_chain_descr + " (disconnected)";
            }
        });

        // Set index / source
        let o = [...this._side_chain.options].find(
            (t) => t.value == this.side_chain
        );
        if (o) {
            this._side_chain.selectedIndex = o.index;
        } else {
            // add side_chain to the list, if it is not in the list
            let o = document.createElement("option");
            o.value = this.side_chain;
            o.text = this.side_chain_descr + " (disconnected)";
            this._side_chain.options.add(o);
        }
    }
}
