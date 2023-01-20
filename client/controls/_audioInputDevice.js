class _audioInputDevice extends _audioDevice {
    constructor() {
        super();
        this.destinations = ["Destination1","Destination2","Destination3"]; // Split with comma from string
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
(Enter the destinations, e.g. 'D1, D2, D3')"
                    rows="1" cols="3"
                    placeholder="Example: Destination1, Destination2, Destination3"
                >${this.destinations.join(', ')}</textarea>
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
            this.destinations = this._destinations.value.split(', ');
            this.NotifyProperty("destinations");
        });

        // Handle property changes

        this.on('destinations', () => {
            this._setDestinations()
        });
    }

    _setDestinations(){
        this._destinations.value = this.destinations.join(', ');
    }
}