class DeviceList extends ui {
    constructor() {
        super();
        this.description = "";
        this.autoStart = false;
        this.autoStartDelay = 500;  // milliseconds
        this._controlsDiv = undefined;
        this.run = false;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="deviceList-main-card">

            <details class="rounded group">

                <!-- Top Heading Container  -->
                <summary class="audioDevice-summary-container">
                    <div class="deviceList-heading">

                        <!-- Name -->
                        <div class="basis-4/5 mt-1">
                            <span class="font-semibold text-2xl" title="Device List Name">${this.name}</span>
                        </div>

                        <div class="flex flex-row items-center justify-items-end justify-end basis-1/5">
                            
                            <!-- Toggle On/Off  -->
                            <div class="mr-4">
                            
                                <div class="flex">
                                    <label class="form-check-label inline-block text-gray-800 mr-2" for="${this._uuid}_switchOnOff">Off</label>
                                    <div class="form-check form-switch">
                                        <input class="deviceList-toggle" type="checkbox" role="switch" id="${this._uuid}_switchOnOff" 
                                        title="Switch Device list on or off">
                                        <label class="form-check-label inline-block text-gray-800" for="${this._uuid}_switchOnOff">On</label>
                                    </div>
                                </div>
                            </div>

                            <!-- Container toggle -->
                            <div class="mr-1">
                                    <div class="deviceList-toggle-arrow">
                                </div>
                            </div>

                        </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#DADBDC]"></div>

                <!-- More Info Container  -->
                <div class="pl-2 flex flex-row justify-between w-full h-auto">

                    <div id="${this._uuid}_audioInputControls" class="pb-4 pt-2 h-auto w-auto"></div>

                    <!-- Settings button  -->
                    <div class="justify-between mt-1">
                        <button id="${this._uuid}_settingsButton" type="button" class="deviceList-btn-settings" 
                        title="Open Device List Settings">
                        </button>
                    </div>

                    <div id="${this._uuid}_settingsContainer" class="deviceList-settingsContainer" >


                        <!-- Exit setting button  -->
                        <div class="flex flex-row justify-between w-full h-auto">
                            <label for="${this._uuid}_description" class="form-label inline-block ml-4 mt-2"
                            >Description: </label>

                            <div class="justify-end">
                                    <button id="${this._uuid}_exitButton" type="button" class="deviceList-btn-exit" 
                                    title="Close Device List Settings">
                                    </button>
                            </div>
                        </div>
                                    
                        <!-- Description  -->
                        <div class="ml-4 mb-2 flex justify-start">
                            <div class="mr-4 w-full">
                            
                                <textarea
                                    class="deviceList-text-area"
                                    id="${this._uuid}_description" rows="3"
                                    placeholder="Your description"
                                    title="Enter a description"
                                ></textarea>
                            </div>
                        </div>

                        <!-- Auto Start Delay  -->
                        <div class="justify-start">
                            <div class="ml-4 mb-2 mr-4">
                                <label for="${this._uuid}_autoStartDelay" class="form-label inline-block"
                                >Auto Start Delay: </label>

                                <input type="number" min="0" oninput="validity.valid||(value='')" id="${this._uuid}_autoStartDelay" title="Set the delay in ms" name="maxVolume" step="1" class="
                                h-6 text-base font-normal text-gray-700 bg-white
                                border border-solid border-gray-300 rounded transition
                                ease-in-out focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none pl-3 py-1.5 w-full"
                                value="${this.autoStartDelay}"
                                >
                            </div>
                        </div>

                        <!-- Auto Start Checkbox  --> 
                        <div class="ml-4 mb-4 flex justify-start">
                            <input type="checkbox" id="${this._uuid}_autoStart" value="${this.autoStart}" class="mr-2 mt-1 h-4 w-4" title="Enable or disable the auto start" />  
                            <label for="${this._uuid}_autoStart" class="form-label inline-block">Auto Start</label>  
                        </div>

                    </div>
                </div>  
            </details> 
        </div>`;

    }

    Init() {
        this._switchOnOff = document.getElementById(`${this._uuid}_switchOnOff`);
        this._description = document.getElementById(`${this._uuid}_description`);
        this._controlsDiv = document.getElementById(`${this._uuid}_audioInputControls`);
        this._exitButton = document.getElementById(`${this._uuid}_exitButton`);
        this._settingsButton = document.getElementById(`${this._uuid}_settingsButton`);
        this._settingsContainer = document.getElementById(`${this._uuid}_settingsContainer`);
        this._autoStartDelay = document.getElementById(`${this._uuid}_autoStartDelay`);
        this._autoStart = document.getElementById(`${this._uuid}_autoStart`);

        this._toggleSettingContainer();

        // Event subscriptions
        this._switchOnOff.addEventListener("click", () => {
            this.run = !this.run;
            this.NotifyProperty("run");
        });

        this._settingsButton.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._exitButton.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._description.addEventListener('change', (e) => {
            this.description = this._description.value;
        });

        this._autoStartDelay.addEventListener('change', (e) => {
            this.autoStartDelay = this._autoStartDelay.value;
        });

        this._autoStart.addEventListener('change', (e) => {
            this.autoStart = !this.autoStart;
        });

        // Handle property changes

        this.on('run', run => {
            this._switchOnOff.value = run;
        });

        this.on('description', description => {
            this._description.value = description;
        });

        this.on('autoStartDelay', autoStartDelay => {
            this._autoStartDelay.value = autoStartDelay;
        });

        this.on('autoStart', autoStart => {
            this._autoStart.value = autoStart;
        });
    }

    _toggleSettingContainer() {
        if (this._settingsContainer.style.display === "none") {
            this._settingsContainer.style.display = "block";
            this._settingsButton.style.display = "none";

        } else {
            this._settingsContainer.style.display = "none";
            this._settingsButton.style.display = "block";
        }
    }

}
