class DeviceList extends ui {
    constructor() {
        super();
        this.deviceType = "DeviceList";
        this.description = "";
        this.autoStart = false;
        this.autoStartDelay = 500;  // milliseconds
        this.run = false;
        this.username = "";
        this.password = "";
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="deviceList-main-card list-group-item">

            <details class="rounded group">

                <!-- Top Heading Container  -->
                <summary class="audioDevice-summary-container">
                    <div class="deviceList-top-bar">
                        <div class="deviceList-top-flex-div">

                            <!-- Name -->
                            <div class="ml-4">
                                <span class="font-semibold text-2xl" title="Device List Name">${this.name}</span>
                            </div>

                            <div class="flex flex-row items-center justify-items-end">
                                <!-- Signal -->
                                <div class="deviceList-btn-signal"
                                    title="Add a new DeviceList">
                                </div>

                                <div class="ml-4">
                                     <span class="font-medium text-xl" title="Device List Name">Signal(to be added)</span>
                                </div>
                            </div>

                            <div class="flex flex-row items-center justify-items-end">
                                
                                <!-- Toggle On/Off  -->
                                <div class="mr-4">
                                
                                    <div class="flex">
                                        <label class="form-check-label inline-block text-gray-800 mr-2" for="@{_switchOnOff}">Off</label>
                                        <div class="form-check form-switch">
                                            <input class="deviceList-toggle" type="checkbox" role="switch" id="@{_switchOnOff}" 
                                            title="Switch Device list on or off">
                                            <label class="form-check-label inline-block text-gray-800" for="@{_switchOnOff}">On</label>
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
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#DADBDC]"></div>

                <!-- More Info Container  -->
                <div class="pl-2 flex flex-row justify-between w-full h-auto">

                    <div id="@{_controlsDiv}" class="pb-4 pt-2 h-auto w-auto"></div>

                    <!-- Settings button  -->
                    <div class="justify-between mt-1">
                        <button id="@{_settingsButton}" type="button" class="deviceList-btn-settings" 
                        title="Open Device List Settings">
                        </button>
                    </div>

                    <div id="@{_settingsContainer}" class="deviceList-settingsContainer" >


                        <!-- Exit setting button  -->
                        <div class="flex flex-row justify-between w-full h-auto">
                            <div class="flex flex-row items-center justify-items-end">

                                <!-- Add Button  -->
                                <button id="@{_addButton}" type="button" class="deviceList-btn-add"
                                data-bs-toggle="modal" data-bs-target="#@{_modal_add_audioDevice}"  
                                    title="Add a new Device">
                                </button>

                                <!-- Duplicate Button  -->
                                <button id="@{_duplicateButton}" type="button" class="deviceList-btn-duplicate"
                                    title="Duplicate DeviceList">
                                </button>
                            </div>
                            
                            <!-- Exit Button  -->
                            <div class="justify-end">
                                    <button id="@{_exitButton}" type="button" class="deviceList-btn-exit" 
                                    title="Close Device List Settings">
                                    </button>
                            </div>
                        </div>
                                    
                        <!-- Description  -->
                        <label for="@{_description}" class="form-label inline-block ml-4 mt-2">Description: </label>
                        <div class="ml-4 mb-2 flex justify-start">
                            <div class="mr-4 w-full">
                            
                                <textarea
                                    class="deviceList-text-area"
                                    id="@{_description}" rows="2"
                                    placeholder="Your description"
                                    title="Device List description"
                                >${this.description}</textarea>
                            </div>
                        </div>

                        <!-- Auto Start Delay  -->
                        <div class="justify-start">
                            <div class="ml-4 mb-2 mr-4">
                                <label for="@{_autoStartDelay}" class="form-label inline-block"
                                >Auto Start Delay: </label>

                                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_autoStartDelay}" title="Set the delay in milliseconds" name="maxVolume" step="1" class="
                                h-6 text-base font-normal text-gray-700 bg-white
                                border border-solid border-gray-300 rounded transition
                                ease-in-out focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none pl-3 py-1.5 w-full"
                                value="${this.autoStartDelay}"
                                >
                            </div>
                        </div>

                        <!-- Auto Start Checkbox  --> 
                        <div class="ml-4 mb-2 flex justify-start">
                            <input type="checkbox" id="@{_autoStart}" value="${this.autoStart}" class="mr-2 mt-1 h-4 w-4" title="Enable or disable the auto start" />  
                            <label for="@{_autoStart}" class="form-label inline-block">Auto Start</label>  
                        </div>

                        <!-- Username  -->
                        <label for="@{_userName}" class="form-label inline-block ml-4 mb-2"
                                >Username: </label>

                        <div class="ml-4 mb-2 flex justify-start">
                            <div class="mr-4 w-full">
                                <textarea
                                    class="deviceList-text-area"
                                    id="@{_userName}" rows="1"
                                    placeholder="Your Username"
                                    title="Enter a username"
                                >${this.username}</textarea>
                            </div>
                        </div>

                        <!-- Password  -->
                        <label for="@{_password}" class="form-label inline-block ml-4 mb-2"
                                >Password: </label>

                        <div class="ml-4 mb-2 flex justify-start">
                            <div class="mr-4 w-full">

                                <textarea
                                    class="deviceList-text-area"
                                    id="@{_password}" rows="1"
                                    placeholder="Your password"
                                    title="Enter a password"
                                >${this.password}</textarea>
                            </div>
                        </div>

                        <!-- Remove DeviceList  -->
                        <div class="flex justify-end mb-2">
                            <button type="button" class="deviceList-btn-delete"
                                data-bs-toggle="modal" data-bs-target="#@{_modal_delete}" 
                                title="Remove DeviceList">
                            </button>
                        </div>
                    </div>
                </div>  
            </details> 
        </div>

        <!-- Modal add Audio Device -->
        <div class="modal fade fixed top-0 left-0 hidden w-full h-full outline-none overflow-x-hidden overflow-y-auto"
            id="@{_modal_add_audioDevice}" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm relative w-auto pointer-events-none">
                <div class="modal-content border-none shadow-lg relative flex flex-col w-full pointer-events-auto bg-white bg-clip-padding rounded-md outline-none text-current">
                    <div class="modal-header flex flex-shrink-0 items-center justify-between p-4 border-b border-gray-200 rounded-t-md">

                        <div class="inline modal-header h-[1.875rem] w-[1.875rem] bg-plus_circle_bl bg-cover bg-center bg-no-repeat"></div>
                        <h5 class="ml-2 text-xl font-medium leading-normal text-gray-800" id="exampleModalLabel"> Add Audio Device</h5>

                        <button type="button"
                        class="btn-close box-content w-4 h-4 p-1 text-black border-none rounded-none opacity-50 focus:shadow-none
                        focus:outline-none focus:opacity-100 hover:text-black hover:opacity-75 hover:no-underline"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body relative p-4">
                        <!-- Audio Device Type  -->
                        
                        <label for="@{_deviceType}" class="form-label inline-block mb-2">Device Type:</label>
                        <div class="mb-3 w-full">
                            <select id="@{_deviceType}" title="Choose a Device type" value="" 
                            name="deviceType" class="deviceList-select" type="text">
                            <option value="AudioInput">AudioInput</option>
                            <option value="SrtOpusInput">SrtOpusInput</option>
                            <option value="AudioOutput">AudioOutput</option>
                            <option value="SrtOpusOutput">SrtOpusOutput</option>
                            </select>
                        </div>

                    </div>
                    <div class="modal-footer flex flex-shrink-0 flex-wrap items-center justify-end p-4 border-t border-gray-200 rounded-b-md">
                        
                        <button type="button" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs mr-2
                            leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                            focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                        Cancel</button>
                        
                        <button type="button" id="@{_addAudioDevice}" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs 
                            leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                            focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                        Add</button>
                    </div>
                </div>
            </div>
        </div>


        <!-- Modal remove deviceList conformation -->
        <div class="modal fade fixed top-0 left-0 hidden w-full h-full outline-none overflow-x-hidden overflow-y-auto"
            id="@{_modal_delete}" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm relative w-auto pointer-events-none">
                <div class="modal-content border-none shadow-lg relative flex flex-col w-full pointer-events-auto bg-white bg-clip-padding rounded-md outline-none text-current">
                    <div class="modal-header flex flex-shrink-0 items-center justify-between p-4 border-b border-gray-200 rounded-t-md">

                        <div class="inline modal-header h-[1.875rem] w-[1.875rem] bg-delete_bl bg-cover bg-center bg-no-repeat"></div>
                        <h5 class="ml-2 text-xl font-medium leading-normal text-gray-800" id="exampleModalLabel"> Delete DeviceList</h5>

                        <button type="button"
                        class="btn-close box-content w-4 h-4 p-1 text-black border-none rounded-none opacity-50 focus:shadow-none
                        focus:outline-none focus:opacity-100 hover:text-black hover:opacity-75 hover:no-underline"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body relative p-4">
                        Are you sure you want to delete the DeviceList?
                    </div>
                    <div class="modal-footer flex flex-shrink-0 flex-wrap items-center justify-end p-4 border-t border-gray-200 rounded-b-md">
                        
                        <button type="button" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs mr-2
                            leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                            focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                        Cancel</button>
                        
                        <button type="button" id="@{_deleteDeviceList}" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs 
                            leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                            focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                        Yes</button>
                    </div>
                </div>
            </div>
        </div>
        `;

    }

    Init() {
        
        // Set initial values
        this._toggleSettingContainer();
        this._switchOnOff.checked = this.run;
        this._autoStart.checked = this.autoStart;

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

            this.NotifyProperty("description");
        });

        this._autoStartDelay.addEventListener('change', (e) => {
            this.autoStartDelay = Number.parseInt(this._autoStartDelay.value);

            this.NotifyProperty("autoStartDelay");
        });

        this._autoStart.addEventListener('change', (e) => {
            this.autoStart = !this.autoStart;

            this.NotifyProperty("autoStart");
        });

        this._userName.addEventListener('change', (e) => {
            this.username = this._userName.value;

            this.NotifyProperty("username");
        });

        this._password.addEventListener('change', (e) => {
            this.password = this._password.value;

            this.NotifyProperty("password");
        });

        this._deleteDeviceList.addEventListener('click', (e) => {
            this._notify({remove: true});
            this.SetData({remove: true});
        });

        this._addAudioDevice.addEventListener('click', (e) => {
            // Get unique random name
            let type = this._deviceType.value ;
            function randomName() {
                return type + "_" + Math.round(Math.random() * 10000);
            }
            
            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new audio device
            this.SetData({[name]: {controlType: this._deviceType.value}});
            this.on(name, control => {
                // send newly created audio device's data to manager
                this._notify({[name]: control.GetData()});
            });
        });

        this._duplicateButton.addEventListener('click', (e) => {
            // Get unique random name
            function randomName() {
                return  "router_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this._parent[name]) {
                name = randomName();
            }

            // Create new router
            let dup = this.GetData();
            delete dup.name;

            this._parent.SetData({ [name]: dup });

            // send newly created router's data to manager
            this._parent._notify({ [name]: dup });
        })

        // Handle property changes

        this.on('run', run => {
            this._switchOnOff.checked = run;
        });

        this.on('description', description => {
            this._description.value = description;
        });

        this.on('autoStartDelay', autoStartDelay => {
            this._autoStartDelay.value = autoStartDelay;
        });

        this.on('autoStart', autoStart => {
            this._autoStart.checked = autoStart;
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
