class Router extends ui {
    constructor() {
        super();
        this.deviceType = "Router";
        this.description = "";
        // this.autoStart = false;
        // this.autoStartDelay = 500;  // milliseconds
        this.run = false;
        this.password = "";
        this.displayName = "New Router";
        this.online = false;
        this.sources = [];          // Array with PulseAudio sources
        this.sinks = [];            // Array with PulseAudio sinks
        this.paLatency = 50;        // PulsAudio modules latency (applied to each dynamically loaded PulseAudio module). Lower latency gives higher PulseAudio CPU usage.
        this.displayOrder = 100;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!--    MAIN CARD CONTAINER     -->
        <div class="router-main-card list-group-item">
            <details id="@{_details}" class="rounded group">

                <!--    TOP HEADING CONTAINER    -->
                <summary class="router-summary-container">
                    <div class="router-top-bar">
                        <div class="router-top-flex-div">

                            <div class="router-flex-justify-end min-w-[12rem]">

                                <!--    LIST HANDEL  -->
                                <div  class="router-btn-handel" title="Drag and drop"></div>
                    

                                <!--    ROUTER NAME    -->
                                <div class="ml-1">
                                    <span id="@{_name}" class="font-medium text-2xl" title="Router Name">@{displayName}</span>
                                </div>
                            </div>

                            
                            <div class="router-flex-justify-end">

                                <!--    TOP BAR CONTROLS     -->
                                <div id="@{_topBarControls}" class="h-auto w-auto flex mr-2 items-center" title=""></div>


                                <!--    ONLINE/OFFLINE -->
                                <span id="@{_online}" class="hidden items-center bg-green-100 text-green-800 text-sm font-medium mr-2 px-2.5 py-0.5 rounded-full dark:bg-green-900 dark:text-green-300">
                                <span class="w-2 h-2 mr-1 bg-green-500 rounded-full"></span>
                                Online
                                </span>

                                <span id="@{_offline}" class="inline-flex items-center bg-red-100 text-red-800 text-sm font-medium mr-2 px-2.5 py-0.5 rounded-full dark:bg-red-900 dark:text-red-300">
                                <span class="w-2 h-2 mr-1 bg-red-500 rounded-full"></span>
                                Offline
                                </span>

                                <!--    TOGGLE ON/OFF     
                                <div class="mr-4 flex text-[15px]" title="Switch Router on or off">
                                    <label class="relative inline-flex items-center cursor-pointer">
                                        <span class="router-label">Off</span>
                                            <input id="@{_switchOnOff}" class="sr-only peer" type="checkbox" role="switch" checked="@{run}">
                                            <div class="w-9 h-5 bg-gray-300 rounded-full peer peer-focus:ring-2 dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[3px] after:left-[30px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-blue-500"></div>
                                        <span class="router-label -mr-2 ml-2">On</span>
                                    </label>
                                </div>
                                -->
                                
                                <!--    TOGGLE ON/OFF     -->
                                <div class="mr-4 flex text-[15px]">
                                    <label for="@{_switchOnOff}" class="router-label">Off</label>
                                    <div class="form-check form-switch">
                                        <input id="@{_switchOnOff}" class="router-toggle" type="checkbox"
                                        role="switch" title="Switch Router on or off" checked="@{run}">
                                        <label for="@{_switchOnOff}" class="router-label">On</label>
                                    </div>
                                </div>

                                <!--    CONTAINER TOGGLE     -->
                                <div class="mr-1">
                                    <div class="router-toggle-arrow"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </summary>

                <!--    DIVIDER LINE      -->
                <div class="router-line"></div>

                <!--    MORE INFO CONTAINER       -->
                <div id="@{_moreInfo}" class="router-content">


                    <!--    CHILD DEVICE    -->
                    <div id="@{_controlsDiv}" class="router-devices-div z-10 relative">

                    <!--    ADD BUTTON    -->
                    <button class="router-btn-add" type="button" data-bs-toggle="modal"
                    data-bs-target="#@{_modalAddDevice}" title="Add a new Device"></button>

                    </div>

                    
                    <!--    SETTINGS BUTTON       -->
                    <div class="justify-between z-0">
                        <button id="@{_btnSettings}" class="router-btn-settings"
                        type="button" title="Open Router Settings"> </button>
                    </div>

                    <div id="@{_settingsContainer}" class="router-settingsContainer z-50"  >

                        <!--    EXIT SETTING BUTTON       -->
                        <div class="router-flex-justify-between">
                            <div class="router-flex-justify-end">

                                
                                <!--    DUPLICATE BUTTON      -->
                                <button id="@{_btnDuplicate}" class="router-btn-duplicate" 
                                type="button" title="Duplicate Router"></button>

                                <!--    DELETE ROUTER     -->
                                <button class="router-btn-delete" type="button" data-bs-toggle="modal"
                                data-bs-target="#@{_modalDelete}" title="Remove Router"></button>
                                
                            </div>

                            <!--    EXIT BUTTON   -->
                            <div class="justify-end">
                                <button id="@{_btnExit}" class="router-btn-exit"
                                type="button" title="Close Router Settings"></button>
                            </div>
                        </div>

                        <hr class="w-full h-[0.0625rem] bg-gray-500 mb-2"> 

                        <!--    DISPLAY NAME      -->
                        <label for="@{_displayName}" class="router-label-settings">Display Name: </label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                            
                                <input id="@{_displayName}" class="router-text-area" type="text" maxlength="30"
                                placeholder="Your display name" title="Router display name" value="@{displayName}"/>

                            </div>
                        </div>
                                    
                        <!--    DESCRIPTION       -->
                        <label for="@{_description}" class="router-label-settings">Description: </label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                            
                                <textarea id="@{_description}" class="router-text-area" rows="2"
                                placeholder="Your description" title="Router description">@{description}</textarea>

                            </div>
                        </div>

                        <!--    PASSWORD      -->
                        <label for="@{_password}" class="router-label-settings">Password: </label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                <input id="@{_password}" class="router-text-area"
                                placeholder="Your password" title="Enter a password" value="@{password}"/>
                            </div>
                        </div>

                        <!--    AUTO START DELAY      -->
                        <label for="@{_paLatency}" class="router-label-settings">PulseAudio modules latency:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_paLatency}" class="router-number-range" type="number" min="1" oninput="validity.valid||(value='')"
                                title="Latency setting for PulseAudio modules. Lower latency results in higher CPU usage." step="1" value="@{paLatency}"/>

                            </div>
                        </div>
                    </div>
                </div>  
            </details> 
        </div>

        <!--    MODAL ADD DEVICES    -->
        <div id="@{_modalAddDevice}" class="router-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm router-modal-dialog">
                <div class="router-modal-content">

                    <div class="router-modal-header">
                        <div class="router-modal-img-add"></div>
                        <h5 class="router-modal-heading"> Add Audio Device</h5>
                        <button class="router-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="router-modal-body">

                        <!--    DEVICE TYPE      -->
                        <label for="@{_deviceType}" class="form-label inline-block mb-2">Device Type:</label>
                        <div class="mb-3 w-full">
                            <select id="@{_deviceType}" class="router-select" 
                            title="Choose a Device type" value="" type="text">
                            <option value="AudioInput">Audio Input</option>
                            <option value="AudioOutput">Audio Output</option>
                            <option value="SrtOpusInput">Opus over SRT Input</option>
                            <option value="SrtOpusOutput">Opus over SRT Output</option>
                            </select>
                        </div>
                    </div>

                    <div class="router-modal-footer">
                        
                        <button class="router-modal-btn mr-2" type="button"  
                        data-bs-dismiss="modal"> Cancel</button>
                        
                        <button id="@{_btnAddDevice}" class="router-modal-btn"
                        type="button" data-bs-dismiss="modal"> Add</button>
                    </div>
                    
                </div>
            </div>
        </div>

        <!--    MODAL DELETE ROUTER -->
        <div id="@{_modalDelete}" class="router-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm router-modal-dialog">
                <div class="router-modal-content">

                    <div class="router-modal-header">
                        <div class="router-modal-img-rm"></div>
                        <h5 class="router-modal-heading"> Delete Router</h5>
                        <button class="router-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="router-modal-body">
                    Are you sure you want to delete the Router?
                    </div>

                    <div class="router-modal-footer">
                        
                        <button class="router-modal-btn mr-2" type="button"  
                        data-bs-dismiss="modal"> Cancel</button>
                        
                        <button id="@{_btnDeleteRouter}" class="router-modal-btn"
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
        this._checkOnline();

        this._btnSettings.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._btnExit.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._btnDeleteRouter.addEventListener('click', (e) => {
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
        this.on('online', online => {
            this._checkOnline();
        });
    }

    _checkOnline(){

        if(this.online)
        {
            this._online.style.display = "inline-flex";
            this._offline.style.display = "none";
        }
        else{
            this._online.style.display = "none";
            this._offline.style.display = "inline-flex";
        }
        
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
