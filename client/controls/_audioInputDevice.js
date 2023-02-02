class _audioInputDevice extends _audioDevice {
    constructor() {
        super();
        this.destinations = ["Destination1", "Destination2", "Destination3"]; // Split with comma from string
        this._destinationsList = [];
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <!-- Destinations  -->
        <div class="w-full mb-2 mr-4">
            <label for="@{_destinations}" class="form-label inline-block mb-2">Destinations:</label>
                <textarea
                    class="audioDevice-text-area"
                    id="@{_destinations}"
                    title="Array of strings with destination device name(s)
(Enter the destinations, e.g. 'D1,D2,D3')"
                    rows="1" cols="3"
                    placeholder="Example: Destination1, Destination2, Destination3"
                >${this.destinations.join(',')}</textarea>
        </div>

        <!--    CHILD Checkboxes    -->
        <div id="@{_controlsDiv}" class="w-full flex flex-wrap mr-2 mb-2 justify-start"></div>

        <!-- Additional controls  --> 
        %additionalHtml%

        `);
    }


    Init() {
        super.Init();

        //Event subscriptions
        this._destinations.addEventListener('change', (e) => {
            this.destinations = this._destinations.value.split(',');
            this.NotifyProperty("destinations");
        });

        // Handle property changes
        this.on('destinations', () => {
            this._setDestinations()
        });
        
        this._parent.on('newChildControl', c => {
            this._addDestination(c);
        });

        // Add destination if new _audioInputDevice control is added to the parent
        this.on('init', () => {
            // Scan for valid destination
            Object.values(this._parent._controls).forEach(control => {
                this._addDestination(control);
            });
        });
        

        this.on('newChildControl', control => {
            try {
                if (control instanceof checkBox) {
                    let dstName = control.name.replace('dst_', '');
                    let dstControl = this._parent[dstName];
                    if (dstControl) {
                        this._addDestination(dstControl);
                    }
                }
            } catch { }
        });
    }

    _setDestinations() {
        this._destinations.value = this.destinations.join(',');
    }

    //Add destination if new _audioInputDevice control is added to the parent
    _addDestination(dstControl) {
        try {
            if (dstControl instanceof _audioOutputDevice) {
                let name = 'dst_' + dstControl.name;
                let existing = this[name] != undefined;

                // Create new checkbox
                if (!existing) {
                    // Create new checkBox control
                    this.one(name, control => {
                        // send newly created audio device's data to manager
                        this._notify({ [name]: control.GetData() });
                    });

                    this.SetData({ [name]: { controlType: "checkBox", label: dstControl.name } });
                } else {
                    // Subscribe to control remove event to remove destination checkbox controls
                    dstControl.one('remove', control => {
                        this.SetData({ [name]: { remove: true } });
                        this._notify({ [name]: { remove: true } });
                    });
                }
            }
        } catch { }
    }
}