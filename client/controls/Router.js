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
        this.height = 700;
        this.width = 1500;
        this.scale = 1;
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
                                <span id="@{_online}" class="hidden items-center bg-green-600 text-white text-sm font-medium mr-2 px-2.5 py-0.5 rounded-full">
                                <span class="w-2 h-2 mr-1 bg-white rounded-full"></span>
                                Online
                                </span>

                                <span id="@{_offline}" class="inline-flex items-center bg-red-100 text-red-800 text-sm font-medium mr-2 px-2.5 py-0.5 rounded-full">
                                <span class="w-2 h-2 mr-1 bg-red-500 rounded-full"></span>
                                Offline
                                </span>

                                <!--    TOGGLE ON/OFF     
                                <div class="mr-4 flex text-[15px]" title="Switch Router on or off">
                                    <label class="relative inline-flex items-center cursor-pointer">
                                        <span class="router-label">Off</span>
                                            <input id="@{_switchOnOff}" class="sr-only peer" type="checkbox" role="switch" checked="@{run}">
                                            <div class="w-9 h-5 bg-gray-300 rounded-full peer peer-focus:ring-2 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[3px] after:left-[30px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
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

                    <div class="h-8 w-8 z-50 top-11 left-1 absolute rounded-full bg-white bg-opacity-50 pl-[0.5px] pb-[1.5px]"
                        <!--    ADD BUTTON    -->
                        <button class="router-btn-add " type="button" data-bs-toggle="modal"
                        data-bs-target="#@{_modalAddDevice}" title="Add a new Device"></button>
                    </div>

                    <div id="@{_scrollDiv}" class="overflow-scroll block w-full h-full max-h-[750px]">
                        <!--    CHILD DEVICE    -->
                        <div id="@{_controlsDiv}" class="router-devices-div z-10 block relative transform scale-100 origin-top-left"> </div>
                    </div>

                    <div class="h-8 w-8 z-50 top-11 right-5 absolute rounded-full bg-white bg-opacity-50"
                        <!--    SETTINGS BUTTON       -->
                        <div class="justify-between">
                            <button id="@{_btnSettings}" class="router-btn-settings"
                            type="button" title="Open Router Settings"> </button>
                        </div>
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

                        <hr class="w-full h-[1px] bg-gray-500 mb-2"> 

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

                        <hr class="w-full h-[1px] bg-gray-500 mt-1 mb-2"> 

                        <!--    Height      -->
                        <label for="@{_height}" class="router-label-settings">Router page height:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_height}" class="router-number-range" type="number" min="0" oninput="validity.valid||(value='')"
                                title="Page height in px (Min: 450)" step="1" value="@{height}"/>

                            </div>
                        </div>
                        

                        <!--    Width    -->  
                        <label for="@{_width}" class="router-label-settings">Router page width:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_width}" class="router-number-range" type="number" min="0" oninput="validity.valid||(value='')"
                                title="Page width in px" step="1" value="@{width}"/>

                            </div>
                        </div>

                        <!--    Scale    -->  
                        <label for="@{_scale}" class="router-label-settings">Router control's scale:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_scale}" class="router-number-range" type="number" step="0.05" min="0.1" max=2 oninput="validity.valid||(value='1')"
                                title="Page width in px" step="1" value="@{scale}"/>

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
                            <option value="Separator">Separator</option>
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

        // Workaround: set page height and width after css is applied
        setTimeout(() => {
            this._controlsDiv.style.height = this.height + "px";
            this._controlsDiv.style.width = this.width + "px";
        }, 100);

        this._height.addEventListener('change', (e) => {
            if (this._height.value <= 450) {
                this._height.value = 450;
                this.height = 450;
            }
        })

        this._width.addEventListener('change', (e) => {
            if (this._width.value <= 450) {
                this._width.value = 450;
                this.width = 450;
            }
        })

        this.on('width', width => {
            if (this.scale <= 1) {
                this._controlsDiv.style.width = (this.width / this.scale) + "px";
            }
            else {
                this._controlsDiv.style.width = (this.width * this.scale) + "px";
            }
        });


        this.on('height', height => {

            if (this.scale <= 1) {
                this._controlsDiv.style.height = (this.height / this.scale) + "px";
            }
            else {
                this._controlsDiv.style.height = (this.height * this.scale) + "px";
            }
        });

        this._btnSettings.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._btnExit.addEventListener('click', (e) => {
            this._toggleSettingContainer();
        });

        this._btnDeleteRouter.addEventListener('click', (e) => {
            this._notify({ remove: true });
            this.SetData({ remove: true });
        });

        this._btnAddDevice.addEventListener('click', (e) => {
            // Get unique random name
            let type = this._deviceType.value;
            function randomName() {
                return type + "_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new audio device
            this.SetData({ [name]: { controlType: this._deviceType.value } });
            this.on(name, control => {
                // send newly created audio device's data to manager
                this._notify({ [name]: control.GetData() });
            });
        });

        this._btnDuplicate.addEventListener('click', (e) => {
            // Get unique random name
            function randomName() {
                return "router_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this._parent[name]) {
                name = randomName();
            }

            // Create new router
            let dup = this.GetData();
            delete dup.name;
            delete dup.online;
            delete dup.run;
            dup.name = name;        // Manually set name. This is used by the manager service as a unique router socket identification.

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

        //----------------------Scaling-----------------------------//
        this.on('scale', scale => {
            this._setScale();
        }, { immediate: true });

        // let isAltKeyPressed = false; // Flag to track Alt key press

        // document.addEventListener('keydown', (event) => {
        //     if (event.key === 'Alt') {
        //         isAltKeyPressed = true;
        //         this._scrollDiv.style.cursor = 'zoom-in'; // Show zoom-in cursor when Alt key is pressed
        //     }
        // });

        // document.addEventListener('keyup', (event) => {
        //     if (event.key === 'Alt' || (event.ctrlKey && event.altKey))  {
        //         isAltKeyPressed = false;
        //         this._scrollDiv.style.cursor = 'auto'; // Reset cursor when Alt key is released
        //     }
        // });

        // document.addEventListener('keydown', (event) => {
        //     if (event.key === '+' || event.key === '=') {
        //         if (isAltKeyPressed) {
        //             this._scrollDiv.style.cursor = 'zoom-in';
                    
        //             this.scale += 0.05;
        //             // Ensure scale doesn't go above 2
        //             this.scale = Math.min(this.scale, 2);

        //             // Round the scale value to two decimal places
        //             this.scale = parseFloat(this.scale.toFixed(2));
        //             this._setScale();
        //         }
        //     }

        //     if (event.key === '-') {
        //         if (isAltKeyPressed) {
                    
        //             this.scale -= 0.05;
        //             // Ensure scale doesn't go below 0.1
        //             this.scale = Math.max(this.scale, 0.1);

        //             // Round the scale value to two decimal places
        //             this.scale = parseFloat(this.scale.toFixed(2));
        //             this._setScale();
        //         }
        //     }
        // });

        // this._scrollDiv.addEventListener('mousedown', (event) => {
        //     if (isAltKeyPressed) {
        //         this._scrollDiv.style.cursor = 'zoom-in';
        //         if (event.button === 0) {
        //             // Left click to increase scale
        //             this.scale += 0.05;
        //             // this.scale = Number.parseFloat(this.scale).toFixed(2);
        //             // Ensure scale doesn't go above 2
        //             this.scale = Math.min(this.scale, 2);
        //         } else if (event.button === 2) {
        //             // Right click to decrease scale
        //             this.scale -= 0.05;
        //             // Ensure scale doesn't go below 0.1
        //             this.scale = Math.max(this.scale, 0.1);
        //         }

        //         // Round the scale value to two decimal places
        //         this.scale = parseFloat(this.scale.toFixed(2));
        //         this._setScale();
        //     }
        // });

        // this._scrollDiv.addEventListener('contextmenu', (event) => {
        //     if (isAltKeyPressed) {
        //         event.preventDefault(); // Prevent the default right-click context menu when Alt key is pressed
        //     }
        // });
        //----------------------Scaling-----------------------------//
    }

    _setScale() {
        if (this._controlsDiv) {
            this._controlsDiv.style.transform = "scale(" + this.scale + "," + this.scale + ")";  // Apply the scale transformation to the control element

            this._controlsDiv.style.height = (this.height / this.scale) + "px";
            this._controlsDiv.style.width = (this.width / this.scale) + "px";

            // this._scrollDiv.scrollTop = this._scrollDiv.scrollTop * this.scale;
            // this._scrollDiv.scrollLeft = this._scrollDivscrollLeft * this.scale;


        }
    }


    _checkOnline() {

        if (this.online) {
            this._online.style.display = "inline-flex";
            this._offline.style.display = "none";
        }
        else {
            this._online.style.display = "none";
            this._offline.style.display = "inline-flex";
        }

    }

    _toggleSettingContainer() {
        if (this._settingsContainer.style.display === "none") {
            this._btnSettings.style.display = "none";
            this._settingsContainer.style.display = "block";

        } else {
            this._settingsContainer.style.display = "none";
            this._btnSettings.style.display = "block";
        }
    }
}
