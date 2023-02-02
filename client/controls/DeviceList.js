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
        this.displayName = "New Router";
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!--    MAIN CARD CONTAINER     -->
        <div class="deviceList-main-card list-group-item">
            <details id="@{_details}" class="rounded group">

                <!--    TOP HEADING CONTAINER    -->
                <summary class="deviceList-summary-container">
                    <div class="deviceList-top-bar">
                        <div class="deviceList-top-flex-div">

                            <div class="deviceList-flex-justify-end">

                                <!--    LIST HANDEL  -->
                                <div class="deviceList-btn-handel" title="Drag and drop"></div>

                                <!--    DEVICE LIST NAME    -->
                                <div class="ml-4">
                                    <span id="@{_name}" class="font-semibold text-2xl" title="Device List Name">${this.displayName}</span>
                                </div>
                            </div>

                            <div class="deviceList-flex-justify-end">

                                <!--    ONLINE/OFFLINE -->
                                <div class="deviceList-btn-signal"
                                    title="Add a new DeviceList">
                                </div>

                                <div class="ml-4">
                                     <span class="font-medium text-xl" title="Device List Name">Online/Offline</span>
                                </div>
                            </div>

                            <div class="deviceList-flex-justify-end">
                                
                                <!--    TOGGLE ON/OFF     -->
                                <div class="mr-4 flex">
                                    <label for="@{_switchOnOff}" class="deviceList-label">Off</label>
                                    <div class="form-check form-switch">
                                        <input id="@{_switchOnOff}" class="deviceList-toggle" type="checkbox"
                                        role="switch" title="Switch Device list on or off">
                                        <label for="@{_switchOnOff}" class="deviceList-label">On</label>
                                    </div>
                                </div>

                                <!--    CONTAINER TOGGLE     -->
                                <div class="mr-1">
                                    <div class="deviceList-toggle-arrow"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </summary>

                <!--    DIVIDER LINE      -->
                <div class="deviceList-line"></div>

                <!--    MORE INFO CONTAINER       -->
                <div id="@{_moreInfo}" class="deviceList-content">

                    <!--    ADD BUTTON    -->
                    <button class="deviceList-btn-add" type="button" data-bs-toggle="modal"
                    data-bs-target="#@{_modalAddDevice}" title="Add a new Device"></button>

                    <!--    CHILD DEVICE    -->
                    <div id="@{_controlsDiv}" class="deviceList-devices-div z-10 relative"></div>

                    
                    <!--    SETTINGS BUTTON       -->
                    <div class="justify-between mt-1 z-50">
                        <button id="@{_btnSettings}" class="deviceList-btn-settings"
                        type="button" title="Open Device List Settings"> </button>
                    </div>

                    <div id="@{_settingsContainer}" class="deviceList-settingsContainer z-50"  >

                        <!--    EXIT SETTING BUTTON       -->
                        <div class="deviceList-flex-justify-between">
                            <div class="deviceList-flex-justify-end">

                                
                                <!--    DUPLICATE BUTTON      -->
                                <button id="@{_btnDuplicate}" class="deviceList-btn-duplicate" 
                                type="button" title="Duplicate DeviceList"></button>

                                <!--    DELETE DEVICE LIST     -->
                                <button class="deviceList-btn-delete" type="button" data-bs-toggle="modal"
                                data-bs-target="#@{_modalDelete}" title="Remove DeviceList"></button>
                                
                            </div>

                            <!--    EXIT BUTTON   -->
                            <div class="justify-end">
                                <button id="@{_btnExit}" class="deviceList-btn-exit"
                                type="button" title="Close Device List Settings"></button>
                            </div>
                        </div>

                        <hr class="w-full h-[0.0625rem] bg-gray-500 mb-2"> 

                        <!--    DISPLAY NAME      -->
                        <label for="@{_displayName}" class="deviceList-label-settings">Display Name: </label>
                        <div class="deviceList-container">
                            <div class="mr-4 w-full">
                            
                                <input id="@{_displayName}" class="deviceList-text-area" type="text" maxlength="30"
                                placeholder="Your display name" title="Device List display name" value="${this.displayName}"/>

                            </div>
                        </div>
                                    
                        <!--    DESCRIPTION       -->
                        <label for="@{_description}" class="deviceList-label-settings">Description: </label>
                        <div class="deviceList-container">
                            <div class="mr-4 w-full">
                            
                                <textarea id="@{_description}" class="deviceList-text-area" rows="2"
                                placeholder="Your description" title="Device List description">${this.description}</textarea>

                            </div>
                        </div>

                        <!--    AUTO START DELAY      -->
                        <label for="@{_autoStartDelay}" class="deviceList-label-settings">Auto Start Delay: </label>
                        <div class="deviceList-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_autoStartDelay}" class="deviceList-number-range" type="number" min="0" oninput="validity.valid||(value='')"
                                title="Set the delay in milliseconds" name="maxVolume" step="1" value="${this.autoStartDelay}"/>

                            </div>
                        </div>

                        <!--    AUTO START CHECKBOX      --> 
                        <div class="deviceList-container">
                            <input id="@{_autoStart}" class="deviceList-checkbox" type="checkbox"  value="${this.autoStart}"  title="Enable or disable the auto start"/>  
                            <label for="@{_autoStart}" class="ml-2">Auto Start</label>  
                        </div>

                        <!--    USERNAME      -->
                        <label for="@{_userName}" class="deviceList-label-settings">Username: </label>
                        <div class="deviceList-container">
                            <div class="mr-4 w-full">
                                <textarea id="@{_userName}" class="deviceList-text-area" rows="1"
                                placeholder="Your Username" title="Enter a username">${this.username}</textarea>
                            </div>
                        </div>

                        <!--    PASSWORD      -->
                        <label for="@{_password}" class="deviceList-label-settings">Password: </label>
                        <div class="deviceList-container">
                            <div class="mr-4 w-full">
                                <textarea id="@{_password}" class="deviceList-text-area" rows="1"
                                placeholder="Your password" title="Enter a password">${this.password}</textarea>
                            </div>
                        </div>

                    </div>
                </div>  
            </details> 
        </div>

        <!--    MODAL ADD DEVICES    -->
        <div id="@{_modalAddDevice}" class="deviceList-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm deviceList-modal-dialog">
                <div class="deviceList-modal-content">

                    <div class="deviceList-modal-header">
                        <div class="deviceList-modal-img-add"></div>
                        <h5 class="deviceList-modal-heading"> Add Audio Device</h5>
                        <button class="deviceList-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="deviceList-modal-body">

                        <!--    DEVICE TYPE      -->
                        <label for="@{_deviceType}" class="form-label inline-block mb-2">Device Type:</label>
                        <div class="mb-3 w-full">
                            <select id="@{_deviceType}" class="deviceList-select" 
                            title="Choose a Device type" value="" type="text">
                            <option value="AudioInput">AudioInput</option>
                            <option value="SrtOpusInput">SrtOpusInput</option>
                            <option value="AudioOutput">AudioOutput</option>
                            <option value="SrtOpusOutput">SrtOpusOutput</option>
                            </select>
                        </div>
                    </div>

                    <div class="deviceList-modal-footer">
                        
                        <button class="deviceList-modal-btn mr-2" type="button"  
                        data-bs-dismiss="modal"> Cancel</button>
                        
                        <button id="@{_btnAddDevice}" class="deviceList-modal-btn"
                        type="button" data-bs-dismiss="modal"> Add</button>
                    </div>
                    
                </div>
            </div>
        </div>

        <!--    MODAL DELETE DEVICE LIST -->
        <div id="@{_modalDelete}" class="deviceList-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm deviceList-modal-dialog">
                <div class="deviceList-modal-content">

                    <div class="deviceList-modal-header">
                        <div class="deviceList-modal-img-rm"></div>
                        <h5 class="deviceList-modal-heading"> Delete DeviceList</h5>
                        <button class="deviceList-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="deviceList-modal-body">
                    Are you sure you want to delete the DeviceList?
                    </div>

                    <div class="deviceList-modal-footer">
                        
                        <button class="deviceList-modal-btn mr-2" type="button"  
                        data-bs-dismiss="modal"> Cancel</button>
                        
                        <button id="@{_btnDeleteDeviceList}" class="deviceList-modal-btn"
                        type="button" data-bs-dismiss="modal"> Delete</button>
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

        this._btnSettings.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._btnExit.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._description.addEventListener('change', (e) => {
            this.description = this._description.value;
            this.NotifyProperty("description");
        });

        this._displayName.addEventListener('change', (e) => {
            this.displayName = this._displayName.value;
            this._name.innerHTML  = this._displayName.value;
            this.NotifyProperty("displayName");
        })

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

        this._btnDeleteDeviceList.addEventListener('click', (e) => {
            this._notify({remove: true});
            this.SetData({remove: true});
        });

        this._btnAddDevice.addEventListener('click', (e) => {
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

        this._btnDuplicate.addEventListener('click', (e) => {
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
            dup.displayName += " (copy)"

            this._parent.SetData({ [name]: dup });

            // send newly created router's data to manager
            this._parent._notify({ [name]: dup });

            // Close group
            this._details.removeAttribute("open");
        });

        // Handle property changes
        this.on('run', run => {
            this._switchOnOff.checked = run;
        });

        this.on('description', description => {
            this._description.value = description;
        });

        this.on('displayName', displayName => {
            this._displayName.value = displayName;
            this._name.innerHTML = displayName;
        })

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
            this._btnSettings.style.display = "none";

        } else {
            this._settingsContainer.style.display = "none";
            this._btnSettings.style.display = "block";
        }
    }
}
