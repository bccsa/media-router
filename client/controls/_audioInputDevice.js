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

        <!-- Additional controls  --> 
        %additionalHtml%

        `);
    }

 
    Init() {
        super.Init();
        // this._destinations = document.getElementById(`${this._uuid}_destinations`);

        //Event subscriptions
        this._destinations.addEventListener('change', (e) => {
            this.destinations = this._destinations.value.split(',');
            this.NotifyProperty("destinations");
        });
        
        // Handle property changes
        this.on('destinations', () => {
            this._setDestinations()
        });

        // Scan for valid destinations (objects extending the _audioOutputDevice class)
        this._destinationsList = [];
        try {
            Object.values(this._parent._controls).filter(t => t instanceof _audioOutputDevice).forEach(d => {
                this._destinationsList.push(d.name);
            });
        } catch {}
        

        // Add destination if new _audioInputDevice control is added to the parent
        this._parent.on('controlAdded', c => {
            try {
                if (c instanceof _audioOutputDevice) {
                    this._destinationsList.push(c.name);
                }
            } catch {}
        });

        // Remove destination if _audioInputDevice control is removed from the parent
        this._parent.on('controlRemoved', c => {
            try {
                if (c instanceof _audioOutputDevice) {
                    this._destinationsList.splice(this._destinationsList.indexOf(c.name), 1);
                }
            } catch {}
        });
    }

    _setDestinations(){
        this._destinations.value = this.destinations.join(',');
    }
}