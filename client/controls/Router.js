class Router extends ui {
    constructor() {
        super();
        this.deviceType = "Router";
        this.description = "";
        this.startupState = true; // true = Auto (manager selected state); false = Start in stopped state.
        this.startupDelayTime = 3000; // milliseconds
        this.run = false;
        this.password = "";
        this.displayName = "New Router";
        this.online = false;
        this.sources = []; // Array with PulseAudio sources
        this.sinks = []; // Array with PulseAudio sinks
        this.paLatency = 50; // PulsAudio modules latency (applied to each dynamically loaded PulseAudio module). Lower latency gives higher PulseAudio CPU usage.
        this.displayOrder = 100;
        this.height = 700;
        this.width = 1500;
        this.scale = 1;
        this.log = []; // controls output logs
        this.logLimit = 100; // max amout of logs in list
        this.logMessage = []; // Last log message
        this.fetchLog = false; // Toggle from fron end to fetch log on page load
        this.logINFO = false; // log level enabled/ disabled
        this.logERROR = false; // log level enabled/ disabled
        this.logFATAL = true; // log level enabled/ disabled
        this.resetCmd = false; // Reset router process
        this.restartCmd = false; // Restart router device
        this.startLocalCTR = false; // Start local control panel (When the MR starts) (!!! This script was build for bookworm / noble / bullseye, if you have a diffrent release update teh script in ./media-router/server/scripts/start-localCTR.sh)
        this.cpuUsage = 0; // CPU usage indication
        this.cpuTemperature = 0; // CPU temperature indication
        this.memoryUsage = 0; // Memory usage indication
        this.ipAddress = "127.0.0.1"; // system IP address
        this.buildNumber = "DEV"; // buildNumber Build number
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

                                <!--    Memory Usage Indication -->
                                <div id="@{_memoryUsage}" class="items-center - text-center justify-items-center bg-slate-300 text-white text-sm font-medium mr-2 px-2.5 py-0.5 w-24 rounded-full">MEM: <span>@{memoryUsage}</span>%</div>

                                <!--    CPU Usage Indication -->
                                <div id="@{_cpuUsage}" class="items-center - text-center justify-items-center bg-slate-300 text-white text-sm font-medium mr-2 px-2.5 py-0.5 w-24 rounded-full">CPU: <span>@{cpuUsage}</span>%</div>

                                <!--    CPU Temperature Indication -->
                                <div id="@{_cpuTemperature}" class="items-center - text-center justify-items-center bg-slate-300 text-white text-sm font-medium mr-2 px-2.5 py-0.5 w-36 rounded-full">TEMP: <span>@{cpuTemperature}</span>&deg;C</div>

                                <!--    ONLINE/OFFLINE -->
                                <span id="@{_online}" class="hidden items-center  bg-green-600 text-white text-sm font-medium mr-2 px-2.5 py-0.5 rounded-full">
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
                                
                                <!--    RESET ROUTER     -->
                                <button class="router-btn-reset" type="button" data-bs-toggle="modal"
                                data-bs-target="#@{_modalReset}" title="Reset Router"></button>

                                <!--    RESTART ROUTER     -->
                                <button class="router-btn-restart" type="button" data-bs-toggle="modal"
                                data-bs-target="#@{_modalRestart}" title="Restart Router"></button>

                                <!--    HELP MODAL     -->
                                <button id="@{_btnHelp}" class="router-btn-help" type="button" data-bs-toggle="modal"
                                data-bs-target="#@{_modalHelp}" title="Help"></button>
                            </div>

                            <!--    EXIT BUTTON   -->
                            <div class="justify-end">
                                <button id="@{_btnExit}" class="router-btn-exit"
                                type="button" title="Close Router Settings"></button>
                            </div>
                        </div>

                        <hr class="w-full h-[1px] bg-gray-500 mb-2"> 

                        <! --   Info Section   -->
                        <!--    IP Address     -->
                        <div class="router-container">
                            <label for="@{_ipAddress}" class="">IP Address: <span>@{ipAddress}</span></label>
                        </div>    
                    
                        <!--    Build Number     -->
                        <div class="router-container flex grid grid-cols-1">
                            <label for="@{_buildNumber}" class="">Build Number:</label>
                            <div>@{buildNumber}</div>
                        </div>  

                        <!--    DIVIDER LINE      -->
                        <div class="router-line mb-4"></div>

                        <! --  Setting  -->
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

                        <!--    PULSEAUDIO LATENCY      -->
                        <label for="@{_paLatency}" class="router-label-settings">PulseAudio modules latency:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_paLatency}" class="router-number-range" type="number" min="1" oninput="validity.valid||(value='')"
                                title="Latency setting for PulseAudio modules. Lower latency results in higher CPU usage." step="1" value="@{paLatency}"/>

                            </div>
                        </div>

                        <!--    STARTUP DELAY      -->
                        <label for="@{_startupDelayTime}" class="router-label-settings">Startup delay:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_startupDelayTime}" class="router-number-range" type="number" min="1" oninput="validity.valid||(value='')"
                                title="Startup delay time in milliseconds. This is sometimes needed to give other services (e.g. PulseAudio) sufficient time to start up." step="1" value="@{startupDelayTime}"/>

                            </div>
                        </div>

                        <!--    STARTUP STATE      -->
                        <label for="@{_startupState}" class="router-label-settings">Startup state:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                <select id="@{_startupState}" class="paAudioBase-select" title="Auto: manager selected state; Stopped = Start in stopped state" value="@{startupState}">
                                    <option value=true>Auto</option>
                                    <option value=false>Stopped</option>
                                </select>

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

                        <!--    Lunch local control panel on device   -->  
                        <label for="@{_startLocalCTR}" class="router-label-settings">Start local control panel:</label>
                        <div class="router-container">
                            <label class="relative inline-flex items-center cursor-pointer">
                            <span class="router-label">Off</span>
                                <input id="@{_startLocalCTR}" class="sr-only peer" type="checkbox" role="switch" checked="@{startLocalCTR}">
                                <div class="w-9 h-5 bg-gray-300 rounded-full peer peer-focus:ring-2 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[3px] after:left-[30px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-500"></div>
                            <span class="router-label -mr-2 ml-2">On</span>
                        </div>

                        <!--    Log limit    -->  
                        <label for="@{_scale}" class="router-label-settings">Log Limit:</label>
                        <div class="router-container">
                            <div class="mr-4 w-full">
                                
                                <input id="@{_logLimit}" class="router-number-range" type="number" step="1" min="1" oninput="validity.valid||(value='1')"
                                title="Maximum amount of log entries to be displayed in the console" step="1" value="@{logLimit}"/>

                            </div>
                        </div>

                    </div> 
                </div> 

                <!--   console window   -->
                <div class="flex justify-center m-2">
                    <button class="mr-2" id="@{_console}">Console</button>
                    <input checked="@{logFATAL}" id="@{_logFATAL}" type="checkbox" value="FATAL" class="mr-1 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500">
                    <label class="mr-2" for="@{_logFATAL}">Fatal</label>
                    <input checked="@{logERROR}" id="@{_logERROR}" type="checkbox" value="ERROR" class="mr-1 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500">
                    <label class="mr-2" for="@{_logERROR}">Error</label>
                    <input checked="@{logINFO}" id="@{_logINFO}" type="checkbox" value="INFO" class="mr-1 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500">
                    <label class="mr-2" for="@{_logINFO}">Info</label>
                </div>
                <pre id="@{_log}" class="text-sm h-60 overflow-auto p-2 bg-slate-800 text-slate-50 col-span-4 snap-y"></pre>

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
                            <option value="SrtRelay">Srt Relay</option>
                            <option value="SoundProcessor">PCM Sound Processor</option>
                            <option value="SoundDucking">PCM Sound Ducking</option>
                            <option value="SrtVideoPlayer">Video over SRT Player</option>
                            <option value="SrtVideoEncoder">Video over SRT Encoder</option>
                            <option value="HlsPlayer">Hls Video Player</option>
                            <option value="WebRTCClient">WebRTC Client WebApp</option>
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

        <!--    MODAL RESET ROUTER -->
        <div id="@{_modalReset}" class="router-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm router-modal-dialog">
                <div class="router-modal-content">

                    <div class="router-modal-header">
                        <div class="router-modal-img-reset"></div>
                        <h5 class="router-modal-heading"> Reset Router</h5>
                        <button class="router-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="router-modal-body">
                    Are you sure you want to reset the Router?
                    </div>

                    <div class="router-modal-footer">
                        
                        <button class="router-modal-btn mr-2" type="button"  
                        data-bs-dismiss="modal">Cancel</button>
                        
                        <button id="@{_btnReset}" class="router-modal-btn"
                        type="button" data-bs-dismiss="modal">Reset</button>
                    </div>
                </div>
            </div>
        </div>

        <!--    MODAL RESTART ROUTER -->
        <div id="@{_modalRestart}" class="router-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-sm router-modal-dialog">
                <div class="router-modal-content">

                    <div class="router-modal-header">
                        <div class="router-modal-img-restart"></div>
                        <h5 class="router-modal-heading"> Restart Router</h5>
                        <button class="router-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="router-modal-body">
                    Are you sure you want to restart the Router?
                    </div>

                    <div class="router-modal-footer">
                        
                        <button class="router-modal-btn mr-2" type="button"  
                        data-bs-dismiss="modal">Cancel</button>
                        
                        <button id="@{_btnRestart}" class="router-modal-btn"
                        type="button" data-bs-dismiss="modal">Restart</button>
                    </div>
                </div>
            </div>
        </div>

        <!--    MODAL Help -->
        <div id="@{_modalHelp}" class="paAudioBase-modal modal fade" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-xl paAudioBase-modal-dialog">
                <div class="modal-dialog paAudioBase-modal-help">
                    <div class="router-modal-content">

                        <div class="paAudioBase-modal-header">
                            <div class="flex flex-shrink-0 items-center justify-between">
                                <span class="appFrame-control-name">Help</span>
                                <div class="flex flex-row">
                                    <!--    CLOSE    -->
                                    <button class="router-modal-btn-close" type="button"
                                    data-bs-dismiss="modal" aria-label="Close"></button>
                                </div>
                            </div>
                        </div>

                        <div class="paAudioBase-modal-body">
                            <div id="@{_modalHelp_md}" class="prose">
                            </div>
                        </div>

                        <div class="paAudioBase-modal-footer">
                            <button class="router-modal-btn mr-2" type="button"  
                            data-bs-dismiss="modal">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    Init() {
        // Set initial values
        this._toggleSettingContainer();

        // Workaround: set page height and width after css is applied
        setTimeout(() => {
            this._controlsDiv.style.height = this.height + "px";
            this._controlsDiv.style.width = this.width + "px";
        }, 100);

        this._height.addEventListener("change", (e) => {
            if (this._height.value <= 450) {
                this._height.value = 450;
                this.height = 450;
            }
        });

        this._width.addEventListener("change", (e) => {
            if (this._width.value <= 450) {
                this._width.value = 450;
                this.width = 450;
            }
        });

        this.on("width", (width) => {
            if (this.scale <= 1) {
                this._controlsDiv.style.width = this.width / this.scale + "px";
            } else {
                this._controlsDiv.style.width = this.width * this.scale + "px";
            }
        });

        this.on("height", (height) => {
            if (this.scale <= 1) {
                this._controlsDiv.style.height =
                    this.height / this.scale + "px";
            } else {
                this._controlsDiv.style.height =
                    this.height * this.scale + "px";
            }
        });

        this._btnSettings.addEventListener("click", (e) => {
            this._toggleSettingContainer();
        });

        this._btnExit.addEventListener("click", (e) => {
            this._toggleSettingContainer();
        });

        this._btnDeleteRouter.addEventListener("click", (e) => {
            this._notify({ remove: true });
            this.SetData({ remove: true });
        });

        this._btnAddDevice.addEventListener("click", (e) => {
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
            this.on(name, (control) => {
                // send newly created audio device's data to manager
                this._notify({ [name]: control.GetData() });
            });
        });

        this._btnDuplicate.addEventListener("click", (e) => {
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
            dup.name = name; // Manually set name. This is used by the manager service as a unique router socket identification.

            dup.displayName += " (copy)";

            this._parent.SetData({ [name]: dup });

            // send newly created router's data to manager
            this._parent._notify({ [name]: dup });

            // Close group
            this._details.removeAttribute("open");
        });

        // Handle property changes
        this.on(
            "online",
            (online) => {
                this._checkOnline();

                if (online) {
                    this._btnReset.style.display = "";
                    this._btnRestart.style.display = "";
                } else {
                    this._btnReset.style.display = "none";
                    this._btnRestart.style.display = "none";
                    // set CPU usage and temp to 0 when offline
                    this.cpuUsage = 0;
                    this.cpuTemperature = 0;
                    this.memoryUsage = 0;
                }
            },
            { immediate: true }
        );

        //----------------------Resource indication-----------------------------//

        const h = (obj, val, disaster, warning) => {
            // red
            if (val > disaster) obj.style.backgroundColor = "rgb(185 28 28)";
            // orange
            else if (val > warning)
                obj.style.backgroundColor = "rgb(245 158 11)";
            // gray
            else obj.style.backgroundColor = "rgb(203 213 225)";
        };

        // Memory Usage indicator
        this.on("memoryUsage", (v) => {
            h(this._memoryUsage, v, 80, 50);
        });

        // Handle CPU load indicator
        this.on("cpuUsage", (v) => {
            h(this._cpuUsage, v, 80, 50);
        });

        // Handle CPU temp indicator
        this.on("cpuTemperature", (v) => {
            h(this._cpuTemperature, v, 85, 70);
        });

        //----------------------Resource indication-----------------------------//

        //----------------------Scaling-----------------------------//
        this.on(
            "scale",
            (scale) => {
                this._setScale();
            },
            { immediate: true }
        );

        // Toggle reset command
        this._btnReset.addEventListener("click", (e) => {
            this.resetCmd = false;
            this.resetCmd = true;
        });

        // Toggle restart command
        this._btnRestart.addEventListener("click", (e) => {
            this.restartCmd = false;
            this.restartCmd = true;
        });
        //----------------------Scaling-----------------------------//

        //----------------------Logging-----------------------------//
        // emit fetch log event
        this.fetchLog = true;

        // listen for logs
        this.on("log", (res) => {
            this._createLog();
        });

        this._log.style.display = "none";

        this.on("logINFO", (val) => {
            this._createLog();
        });
        this.on("logERROR", (val) => {
            this._createLog();
        });
        this.on("logFATAL", (val) => {
            this._createLog();
        });

        this.on("logMessage", (msg) => {
            // Add log to history
            this.log.push(msg);

            // scrolling
            let isScrolled = true;
            if (
                this._log.clientHeight + this._log.scrollTop >=
                this._log.scrollHeight - 20
            )
                isScrolled = false;

            this._addLog(msg);

            if (!isScrolled) this._log.scrollTop = this._log.scrollHeight;
        });

        this._console.addEventListener("click", (e) => {
            if (this._log.style.display == "none")
                this._log.style.display = "block";
            else this._log.style.display = "none";

            this._log.scrollTop = this._log.scrollHeight;
        });
        //----------------------Logging-----------------------------//

        //----------------------Help Modal-----------------------------//

        // Load help from MD
        let _this = this;
        fetch("controls/Router.md")
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("Network response was not ok");
                }
                return response.text();
            })
            .then(function (fileContent) {
                let converter = new showdown.Converter();
                let html = converter.makeHtml(fileContent);
                _this._modalHelp_md.innerHTML = html;
            })
            .catch(function (error) {
                console.error("There was a problem fetching the file:", error);
            });

        //----------------------Help Modal-----------------------------//
    }

    _setScale() {
        if (this._controlsDiv) {
            this._controlsDiv.style.transform =
                "scale(" + this.scale + "," + this.scale + ")"; // Apply the scale transformation to the control element

            this._controlsDiv.style.height = this.height / this.scale + "px";
            this._controlsDiv.style.width = this.width / this.scale + "px";
        }
    }

    _checkOnline() {
        if (this.online) {
            this._online.style.display = "inline-flex";
            this._offline.style.display = "none";
        } else {
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

    _addLog(msg) {
        // clear old log items when log is full
        while (this.log.length > this.logLimit) {
            this.log.shift();
        }

        // add log to html
        if (this[`log${msg[0]}`]) {
            let span = document.createElement("span");
            span.innerHTML = `${msg[1]}\n`;
            this._log.append(span);
            while (this._log.childElementCount > this.logLimit) {
                this._log.removeChild(this._log.children[0]);
            }
        }
    }

    _createLog() {
        // clear console
        while (this._log.firstChild) {
            this._log.removeChild(this._log.firstChild);
        }
        this.log.forEach((msg) => {
            this._addLog(msg);
        });
    }
}
