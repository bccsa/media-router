/**
 * This class should only be used as a super class for Audio devices.
 * Additional HTML content should be added through super.html.replace('%additionalHtml%','Your additional HTML');
 * Also run super.Init() in the overridden Init() function.
 */
class _audioDevice extends ui {
    constructor() {
        super();
        this._styles.push('_audioDevice.css');
        this.level = 0;
        this.mute = true;
        this.description = "";
        this.volume = 1;
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;
        this.peak = 0;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="audioDevice-main-card">

            <details class="shadow rounded group/audioDevice">

                <!-- Top Heading Container  -->
                <summary class="audioDevice-summary-container">
                    <div class="audioDevice-heading">

                            <!-- Name and Volume indicator -->
                            <div class="mb-1 col-span-2">
                                <div class="font-medium text-lg" title="Audio Input Name">${this.name}</div>
                                <div id="@{_volume_slit}" class="audioDevice_volume_slit" title="Audio Indicator"></div>
                            </div>

                            <div class="flex justify-between">
                                <!-- Mute Button -->
                                <button id="@{_control_button}" type="button" title="If true, reduces the audio volume to zero." class="audioDevice-btn-mute">
                                    <span id="@{_control_button_text}">OFF</span>
                                </button>

                                <!-- Container toggle -->
                                <div class="flex w-4 h-full items-start justify-items-end ml-2">
                                    <div class="audioDevice-toggle-arrow"></div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#75C4EB]"></div>

                <!-- More Info Container  -->
                <div class="w-full h-auto m-4 pr-[2rem] text-[14.75px]">

                    <!-- Duplicate & Delete  -->
                    <div class="w-full mr-4 flex justify-end">
                         
                        <button type="button" class="audioDevice-btn-duplicate" id="@{_btn_duplicate}" 
                            title="Duplicate Audio Device">
                        </button>

                        <button type="button" id="@{_btn_delete}" class="audioDevice-btn-delete"
                        title="Delete Audio Device">
                        </button>
                    </div>

                    <!-- Modal remove device conformation -->
                    <div class="modal fade top-0 left-0 hidden w-full h-full outline-none overflow-x-hidden overflow-y-auto"
                        id="@{_modal_delete_AudioDevice}" tabindex="-1" aria-hidden="true">
                        <div class="modal-dialog modal-sm relative w-auto pointer-events-none">
                            <div class="modal-content border-none shadow-lg relative flex flex-col w-full pointer-events-auto bg-white bg-clip-padding rounded-md outline-none text-current">
                                <div class="modal-header flex flex-shrink-0 items-center justify-between p-4 border-b border-gray-200 rounded-t-md">
            
                                    <div class="inline modal-header h-[1.875rem] w-[1.875rem] bg-delete bg-cover bg-center bg-no-repeat"></div>
                                    <h5 class="ml-2 text-xl font-medium leading-normal text-gray-800" id="exampleModalLabel"> Delete Device</h5>
            
                                    <button type="button"
                                    class="btn-close box-content w-4 h-4 p-1 text-black border-none rounded-none opacity-50 focus:shadow-none
                                    focus:outline-none focus:opacity-100 hover:text-black hover:opacity-75 hover:no-underline"
                                    data-bs-dismiss="modal" aria-label="Close"></button>
                                </div>
                                <div class="modal-body relative p-4">
                                    Are you sure you want to delete the Audio Device?
                                </div>
                                <div class="modal-footer flex flex-shrink-0 flex-wrap items-center justify-end p-4 border-t border-gray-200 rounded-b-md">
                                    
                                    <button type="button" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs mr-2
                                        leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                                        focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                                    Cancel</button>
                                    
                                    <button type="button" id="@{_deleteAudioDevice}" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs 
                                        leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
                                        focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out" data-bs-dismiss="modal">
                                    Yes</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Description text area  -->
                    <div class="w-full mb-1 mr-4">
                        <label for="@{_description}" class="form-label inline-block mb-2">Description:</label>
                            <textarea
                                id="@{_description}" class="audioDevice-text-area"
                                title="Device description" rows="1" cols="3"
                                placeholder="Your description" 
                            >${this.description}</textarea>
                    </div>

                    <!-- Solo Group  -->
                    <div class="w-full mr-4">
                        <label for="@{_soloGroup}" class="form-label inline-block mb-2">Solo Group:</label>
                            <textarea
                                class="audioDevice-text-area"
                                id="@{_soloGroup}"
                                title="If not blank, mutes all AudioMixerInputs with the same soloGroup text.";
                                rows="1" cols="3"
                                placeholder="Solo group name:"
                            >${this.soloGroup}</textarea>
                    </div>

                    <!-- Volume Slider  -->
                    <div class="w-full mb-2 flex flex-row items-end">

                        <label for="@{_volume}" class="mt-5 w-1/6">Volume:</label>

                        <input type="range" list="@{_tickMarks}" id="@{_volume_slider}" title="Audio volume (1 = unity gain)" 
                        name="volume" step="0.01" min="0" max="${this.maxVolume}" value="${this.volume}" class="ml-4 mr-4 mt-2 w-4/6 bg-[#293548] text-[#75C4EB]">
                        
                        <datalist id="@{_tickMarks}">
                            <option value="0.00"></option> <option value="0.10"></option> <option value="0.20"></option> 
                            <option value="0.30"></option> <option value="0.40"></option> <option value="0.50"></option>
                            <option value="0.60"></option> <option value="0.70"></option> <option value="0.80"></option> 
                            <option value="0.90"></option> <option value="1.0"0></option> <option value="1.10"></option>
                            <option value="1.20"></option> <option value="1.30"></option> <option value="1.40"></option> 
                            <option value="1.50"></option>
                        </datalist>

                        <label for="@{_volume}" id="@{_rangeBullet}" class="ml-2 w-1/6">${this.volume*100} %</label>
                          
                    </div>

                    <div class="w-full mb-1 flex ">

                        <!-- Channels  -->
                        <div class="w-1/4 mr-3">
                            <label for="@{_channels}" class="form-label inline-block mb-2">Channels:</label>
                                <div class="mb-3 w-full">
                                    <select id="@{_channels}" title="Audio channel number (default = 1)" value="${this.channels}" 
                                    name="channel" class="audioDevice-select" type="text">
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    </select>
                                </div>
                        </div>
                        
                        <!-- SampleRate  -->
                        <div class="w-1/4 mr-3">
                            <label for="@{_sampleRate}" class="form-label inline-block mb-2">Sample Rate:</label>
                            <select id="@{_sampleRate}" title="Audio sample rate (default = 48000)" value="${this.sampleRate}" 
                            name="sampleRate" class="audioDevice-select" type="text">
                                <option value="44100">44100 Hz</option>
                                <option value="48000">48000 Hz</option>
                            </select>
                        </div>

                        <!-- BitDepth  -->    
                        <div class="w-1/4 mr-3">
                            <label for="@{_bitDepth}" class="form-label inline-block mb-2">Bit Depth:</label>
                            <select id="@{_bitDepth}" title="Audio bit depth (default = 16)" value="${this.bitDepth}" 
                            name="bitDepth" class="audioDevice-select" type="text">
                                <option value="16">16</option>
                                <option value="24">24</option>
                                <option value="32">32</option>
                            </select>
                        </div>

                        <!-- Max Volume  --> 
                        <div class="w-1/4">
                            <label for="@{_maxVolume}" class="form-label inline-block mb-2">Max Volume:</label>
                            <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_maxVolume}" 
                            title="Maximum volume that the client WebApp can request" name="maxVolume" step="0.1" class="audioDevice-pos-decimal-input"
                                value="${this.maxVolume}"
                            >
                        </div>

                    </div>

                    <div class="w-full mb-1 flex ">

                        <!-- Show Volume Control Checkbox  --> 
                        <div class="w-1/2 mr-2 mb-2 flex">
                            <input type="checkbox" checked id="@{_showVolumeControl}" value="${this.showVolumeControl}" class="mr-2 mt-1 h-4 w-4" />  
                            <label for="@{_showVolumeControl}" class="form-label inline-block" 
                            title="Indicates that the front end should show the volume control">Show client volume control</label> 
                        </div>

                        <!-- Show Mute Control Checkbox  --> 
                        <div class="w-1/2 mb-2 flex">
                            <input type="checkbox" checked id="@{_showMuteControl}" value="${this.showMuteControl}" class="mr-2 mt-1 h-4 w-4" />  
                            <label for="@{_showMuteControl}" class="form-label inline-block" 
                            title="Indicates that the front end should show the mute control">Show client mute control</label>  
                        </div>

                    </div>
                    
                    <!-- Display Order  -->
                    <div class="w-full mb-1 flex ">

                        <div class="w-1/4 mr-3">
                            <label for="@{_displayOrder}" class="form-label inline-block mb-2">Display Order:</label>
                        </div>
            
                        <div class="w-1/4 mr-3">
                            <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_displayOrder}" 
                            title="Display order in the client WebApp." name="maxVolume" step="1" class="audioDevice-pos-number-input"
                            value="${this.displayOrder}"
                            >
                        </div>

                        <div class="w-1/4 mr-3"></div>
                        <div class="w-1/4"></div>

                    </div>

                    <!-- Additional controls  --> 
                    %additionalHtml%
                </div>  
            </details> 
        </div>
        
        `;

    }

 
    Init() {
        
        // this._volume_slit = document.getElementById(`${this._uuid}_volume_slit`);
        // this._control_button = document.getElementById(`${this._uuid}_control_button`);
        // this._control_button_text = document.getElementById(`${this._uuid}_control_button_text`);
        // this._description = document.getElementById(`${this._uuid}_description`);
        // this._volume_slider = document.getElementById(`${this._uuid}_volume_slider`);
        // this._rangeBullet = document.getElementById(`${this._uuid}_rs-bullet`);
        // this._channels = document.getElementById(`${this._uuid}_channels`);
        // this._sampleRate = document.getElementById(`${this._uuid}_sampleRate`);
        // this._bitDepth = document.getElementById(`${this._uuid}_bitDepth`);
        // this._maxVolume = document.getElementById(`${this._uuid}_maxVolume`);
        // this._soloGroup = document.getElementById(`${this._uuid}_soloGroup`);
        // this._showVolumeControl = document.getElementById(`${this._uuid}_showVolumeControl`);
        // this._showMuteControl = document.getElementById(`${this._uuid}_showMuteControl`);
        // this._displayOrder = document.getElementById(`${this._uuid}_displayOrder`);

        //Set initial values
        this._setMute();
        this._channels.value = this.channels;
        this._sampleRate.value = this.sampleRate;
        this._bitDepth.value = this.bitDepth;
        this._showVolumeControl.checked = this.showVolumeControl;
        this._showMuteControl.checked = this.showMuteControl;



        //Event subscriptions
        this._control_button.addEventListener('click', (e) => {
            this.mute = !this.mute;
            this._setMute();
            this.NotifyProperty("mute");
        });

        this._description.addEventListener('change', (e) => {
            this.description = this._description.value;
            this.NotifyProperty("description");
        });

        this._volume_slider.addEventListener('input', (e) => {
            this.volume = Number.parseFloat(this._volume_slider.value);
            this.showSliderValue();
            this.NotifyProperty("volume");
        });

        this._channels.addEventListener('change', (e) => {
            this.channels = Number.parseInt(this._channels.value);
            this.NotifyProperty("channels");
        });

        this._sampleRate.addEventListener('change', (e) => {
            this.sampleRate = Number.parseInt(this._sampleRate.value);
            this.NotifyProperty("sampleRate");
        });

        this._bitDepth.addEventListener('change', (e) => {
            this.bitDepth = Number.parseInt(this._bitDepth.value);
            this.NotifyProperty("bitDepth");
        });

        this._maxVolume.addEventListener('change', (e) => {
            this.maxVolume = Number.parseFloat(this._maxVolume.value);
            this._volume_slider.max = this.maxVolume;
            this.showSliderValue();
            this.NotifyProperty("maxVolume");
            
            if (this.maxVolume <= this.volume)
            {
                this.volume = Number.parseFloat(this._volume_slider.value);
                this.showSliderValue();
                this.NotifyProperty("volume");
            }
        });

        this._soloGroup.addEventListener('change', (e) => {
            this.soloGroup = this._soloGroup.value;
            this.NotifyProperty("soloGroup");
        });

        this._showVolumeControl.addEventListener('change', (e) => {
            this.showVolumeControl = !this.showVolumeControl;
            this.NotifyProperty("showVolumeControl");
        });

        this._showMuteControl.addEventListener('change', (e) => {
            this.showMuteControl = !this.showMuteControl;
            this.NotifyProperty("showMuteControl");
        });

        this._displayOrder.addEventListener('change', (e) => {
            this.displayOrder = Number.parseInt(this._displayOrder.value);
            this.NotifyProperty("displayOrder");
        });

        this._btn_delete.addEventListener('click', (e) => {
            // Show message box
            this.emit('messageBox',
            {
                buttons: ["yes", "no"],
                title: `Delete ${this.name}?`,
                text: 'Are you really so ready to remove me? Please let me stay???',
                callback: data => {
                    if (data == 'yes') {
                        this._notify({remove: true});
                        this.SetData({remove: true});
                    }
            }}, 'top');
        });

        this._deleteAudioDevice.addEventListener('click', (e) => {
            this._notify({remove: true});
            this.SetData({remove: true});
        });

        this._btn_duplicate.addEventListener('click', (e) => {
        
            // Get unique random name
            let type = this.controlType;
            function randomName() {
                return type + "_" + Math.round(Math.random() * 10000);
            }
            
            let name = randomName();
            while (this._parent[name]) {
                name = randomName();
            }

            // Create new audio device
            let dup = this.GetData();
            delete dup.name;

            this._parent.SetData({[name]: dup});
            
            // send newly created audio device's data to manager
            this._parent._notify({[name]: dup});
            
        
        });

        // Add VU meter
        this.SetData({
            vu: {
                controlType: "VuMeter",
                hideData: true,
                parentElement: `_volume_slit`,
                orientation: "horizontal",
            }
        });

        // Handle property changes

        this.on('level', level => {
            if (this.vu) {
                this.vu.level = level;
            }
        });

        this.on('mute', () => {
            this._setMute();
        });

        this.on('description', description => {
            this._description.value = description;
        });

        this.on('volume', () => {
            this._setVolume();
        });

        this.on('channels', channels => {
            this._channels.value = channels;
        });

        this.on('sampleRate', sampleRate => {
            this._sampleRate.value = sampleRate;
        });

        this.on('bitDepth', bitDepth => {
            this._bitDepth.value = bitDepth;
        });

        this.on('maxVolume', maxVolume => {
            this._maxVolume.value = maxVolume;
            this._volume_slider.max = this.maxVolume;
        });

        this.on('soloGroup', soloGroup => {
            this._soloGroup.value = soloGroup;
        });

        this.on('showVolumeControl', showVolumeControl => {
            this._showVolumeControl.checked = showVolumeControl;
        });

        this.on('showMuteControl', showMuteControl => {
            this._showMuteControl.checked = showMuteControl;
        });

        this.on('displayOrder', displayOrder => {
            this._displayOrder.value = displayOrder;
        });
    }

    _setMute() {
        if (this.mute) {
            this._control_button.style.borderColor = "rgb(6, 154, 46)";
            this._control_button.style.backgroundColor = "rgb(34, 75, 18,0.9)";
            this._control_button.style.boxShadow = "0 0 1px 1px rgb(6, 154, 46, 0.3)";
            this._control_button_text.textContent = "OFF";
        }
        else {
            this._control_button.style.borderColor = "rgb(12, 255, 77)";
            this._control_button.style.backgroundColor = "rgb(6, 154, 46)";
            this._control_button.style.boxShadow = "0 0 10px 5px rgb(6, 154, 46, 0.6)";
            this._control_button_text.textContent = "ON";
        }
    }
    
    _setVolume() {
        if (!this._sliderActive) {
            this._volume_slider.style.top = `${this._sliderBottom - this.volume / this.maxVolume * this._sliderRange}px`;
        }
        this._volume_slider.value = this.volume;
        this._rangeBullet.innerHTML = Math.round(this.volume * 100) + " %";
    }

    showSliderValue() {
        this._rangeBullet.innerHTML = Math.round(this._volume_slider.value * 100) + " %";
    }
}