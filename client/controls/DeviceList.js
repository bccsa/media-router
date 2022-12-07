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
        <div class="select-none drop-shadow-2xl m-2 pl-2 w-auto overflow-hidden bg-white rounded-lg text-black border-solid border border-b-[#DADBDC]">

            <details class="rounded group">
                <summary class="flex list-none cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[10] relative">

                    <!-- Top Heading Container  -->
                    <div class="flex flex-row mt-1 mb-1 ml-4 pl-2 w-full h-10">

                        <!-- Name -->
                        <div class="basis-4/5 mt-1">
                            <span class="font-semibold text-xl" title="Device List Name">${this.name}</span>
                        </div>

                        
                        <div class="flex flex-row items-center justify-end basis-1/5">
                            <div class="flex flex-row items-center justify-end">

                                <!-- Toggle On/Off  -->
                                <div class="basis-1/2 items-center mr-4">
                                
                                    <div class="flex">
                                        <label class="form-check-label1 inline-block text-gray-800 mr-1" for="${this._uuid}_switchOnOff">Off</label>
                                        <div class="form-check form-switch">
                                            
                                            <input class="form-check-input appearance-none w-9 -ml-10 rounded-full float-left h-5 align-top bg-white bg-no-repeat bg-contain bg-gray-300
                                            focus:outline-none cursor-pointer shadow-sm"
                                             type="checkbox" role="switch" id="${this._uuid}_switchOnOff" title="Switch Device list on or off">
                                            <label class="form-check-label2 inline-block text-gray-800" for="${this._uuid}_switchOnOff">On</label>
                                        </div>
                                    </div>
                                </div>

                                <!-- Container toggle -->
                                <div class="basis-1/2 justify-end mr-1">
                                    <div class="flex items-center justify-end">
                                        <div class="mb-4 border-8 border-transparent border-l-black ml-4 mt-1
                                        group-open:rotate-90 transition-transform group-open: origin-left
                                        ">
                                    </div>
                                    </div>
                                </div>

                            </div>
                        </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#DADBDC]"></div>

                <!-- More Info Container  -->
                <div class="flex flex-row justify-between w-full h-auto">

                    <div id="${this._uuid}_audioInputControls" class="pb-4 pt-2 h-auto w-auto"></div>

                    <!-- Settings button  -->
                    <div class="justify-between mt-1">
                        
                            <button id="${this._uuid}_settingsButton" type="button" class="ml-4 bg-cog_solid bg-no-repeat bg-cover bg-center 
                            inline-block rounded-full text-white leading-normal uppercase hover:shadow-lg hover:outline-none hover:ring-0 transition 
                            duration-150 ease-in-out w-8 h-8" title="Open Device List Settings">
                            </button>
                    </div>

                    
                    <div id="${this._uuid}_settingsContainer" class="bg-[#F8FAFC] border-l-[#DADBDC] border-solid border w-auto h-auto ml-4 max-w-xs max-h-xs mt-[0.05rem] ease-in-out hidden" >


                        <!-- Exit setting button  -->
                        <div class="flex flex-row justify-end w-full h-auto">
                            <div class="justify-end">
                                    <button id="${this._uuid}_exitButton" type="button" class="bg-xmark ml-4 bg-no-repeat bg-cover bg-center 
                                    inline-block rounded-full text-white leading-normal uppercase hover:shadow-lg hover:outline-none hover:ring-0 transition 
                                    duration-150 ease-in-out w-8 h-8" title="Close Device List Settings">
                                    </button>
                            </div>
                        </div>
                                    
                        <!-- Description  -->
                        <div class="ml-4 mb-1 flex justify-start">
                            <div class="mb-3 mr-4 w-full">
                            <label for="${this._uuid}_description" class="form-label inline-block mb-2"
                                >Description: </label>
                                <textarea
                                    class="form-control block w-full px-3 py-1.5
                                    text-base font-normal text-gray-700 bg-white bg-clip-padding
                                    border border-solid border-gray-300 rounded transition
                                    ease-in-out max-h-40 min-h-[2rem]
                                    focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none
                                    "
                                    id="${this._uuid}_description"
                                    rows="3"
                                    placeholder="Your description"
                                    title="Enter a description"
                                ></textarea>
                            </div>
                        </div>

                        <!-- Auto Start Delay  -->
                        <div class="justify-start">
                            <div class="ml-4 mb-1 mr-4 xl:w-96">
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
