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
        this.left = "50px";
        this.top = "50px";
        // z-60 fixed hidden w-full h-full outline-none modal fade overflow-scroll
    }

    get html() {
        return `

        <div class="container-div">
            <div class="child-div">
                <div class="div-box">
                    
                </div>
            </div>
        </div>

        <!--    MODAL ADD DEVICES    -->
        <div id="@{_modalAddDevice}" class="fixed h-full w-full hidden fade modal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg deviceList-modal-dialog">
                <div class="deviceList-modal-content" style="z-index: 9999;
                
                width: 50%;
                height: 50%;
                position: fixed;
                top: 50%;
                left: 50%;
                -webkit-transform: translate(-50%, -50%);
                transform: translate(-50%, -50%);">

                    <div class="deviceList-modal-header">
                        <div class="mr-4 flex justify-start">
                            
                            <!--    DUPLICATE    -->
                            <button id="@{_btnDuplicate}" class="audioDevice-btn-duplicate"
                            type="button" data-bs-dismiss="modal" title="Duplicate Audio Device"></button>

                            <!--    DELETE   -->
                            <button id="@{_btnDelete}" class="audioDevice-btn-delete"
                            type="button" data-bs-dismiss="modal" title="Delete Audio Device"></button>

                        </div>

                        <h5 class="deviceList-modal-heading"> ${this.name}</h5>

                        <button class="deviceList-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>

                    <div class="deviceList-modal-body">

                        
                    
            
                        <!--    DESCRIPTION TEXT AREA     -->
                        <div class="w-full mb-1 mr-4">
                            <label for="@{_description}" class="mb-2">Description:</label>
                                <textarea id="@{_description}" class="audioDevice-text-area" rows="1" cols="3"
                                title="Device description" placeholder="Your description" >${this.description}</textarea>
                        </div>

                        <!--    SOLO GROUP    -->
                        <div class="w-full mr-4">
                            <label for="@{_soloGroup}" class="mb-2">Solo Group:</label>
                                <textarea id="@{_soloGroup}" class="audioDevice-text-area" rows="1" cols="3"
                                title="If not blank, mutes all AudioMixerInputs with the same soloGroup text.";
                                placeholder="Solo group name:">${this.soloGroup}</textarea>
                        </div>

                        <!--    VOLUME SLIDER     -->
                        <div class="w-full mb-2 flex flex-row items-end">

                            <label for="@{_volume}" class="mt-5 w-1/6">Volume:</label>

                            <input id="@{_volume_slider}" class="audioDevice-slider" type="range" list="@{_tickMarks}"  title="Audio volume (1 = unity gain)" 
                            name="volume" step="0.01" min="0" max="${this.maxVolume}" value="${this.volume}" >
                            
                            <datalist id="@{_tickMarks}">
                                <option value="0.00"></option> <option value="0.10"></option> <option value="0.20"></option> 
                                <option value="0.30"></option> <option value="0.40"></option> <option value="0.50"></option>
                                <option value="0.60"></option> <option value="0.70"></option> <option value="0.80"></option> 
                                <option value="0.90"></option> <option value="1.0"0></option> <option value="1.10"></option>
                                <option value="1.20"></option> <option value="1.30"></option> <option value="1.40"></option> 
                                <option value="1.50"></option>
                            </datalist>

                            <label for="@{_volume}" id="@{_rangeBullet}" class="ml-2 w-1/6">${this.volume * 100} %</label>
                            
                        </div>

                        <div class="w-full mb-1 flex ">

                            <!--    CHANNELS      -->
                            <div class="w-1/4 mr-3">
                                <label for="@{_channels}" class="mb-2">Channels:</label>
                                    <div class="mb-3 w-full">
                                        <select id="@{_channels}" class="audioDevice-select" title="Audio channel number (default = 1)"
                                        value="${this.channels}" name="channel" type="text">
                                            <option value="1">1</option>
                                            <option value="2">2</option>
                                        </select>
                                    </div>
                            </div>
                            
                            <!--    SAMPLE RATE    -->
                            <div class="w-1/4 mr-3">
                                <label for="@{_sampleRate}" class="mb-2">Sample Rate:</label>
                                <select id="@{_sampleRate}" class="audioDevice-select" title="Audio sample rate (default = 48000)"
                                value="${this.sampleRate}" name="sampleRate" type="text">
                                    <option value="44100">44100 Hz</option>
                                    <option value="48000">48000 Hz</option>
                                </select>
                            </div>

                            <!-- BIT DEPTH   -->    
                            <div class="w-1/4 mr-3">
                                <label for="@{_bitDepth}" class="mb-2">Bit Depth:</label>
                                <select id="@{_bitDepth}" class="audioDevice-select" title="Audio bit depth (default = 16)"
                                value="${this.bitDepth}" name="bitDepth" type="text">
                                    <option value="16">16</option>
                                    <option value="24">24</option>
                                    <option value="32">32</option>
                                </select>
                            </div>

                            <!--    MAX VOLUME    --> 
                            <div class="w-1/4">
                                <label for="@{_maxVolume}" class="mb-2">Max Volume:</label>
                                <input id="@{_maxVolume}" type="number" min="0" oninput="validity.valid||(value='')" 
                                title="Maximum volume that the client WebApp can request" name="maxVolume" step="0.1"
                                class="audioDevice-pos-decimal-input" value="${this.maxVolume}">
                            </div>

                        </div>

                        <div class="w-full mb-1 flex ">

                            <!--    SHOW VOLUME CONTROL CHECKBOX      --> 
                            <div class="w-1/2 mr-2 mb-2 flex">
                                <input id="@{_showVolumeControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked  value="${this.showVolumeControl}"/>  
                                <label for="@{_showVolumeControl}" class="" title="Indicates that the front end should show the volume control">Show client volume control</label> 
                            </div>

                            <!--    SHOW MUTE CONTROL CHECKBOX      --> 
                            <div class="w-1/2 mb-2 flex">
                                <input id="@{_showMuteControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked value="${this.showMuteControl}"/>  
                                <label for="@{_showMuteControl}" class="" title="Indicates that the front end should show the mute control">Show client mute control</label>  
                            </div>

                        </div>
                        
                        <!--    DISPLAY ORDER     -->
                        <div class="w-full mb-1 flex ">

                            <div class="w-1/4 mr-3">
                                <label for="@{_displayOrder}" class="mb-2">Display Order:</label>
                            </div>
                
                            <div class="w-1/4 mr-3">
                                <input id="@{_displayOrder}" class="audioDevice-pos-number-input" type="number" min="0"
                                oninput="validity.valid||(value='')" title="Display order in the client WebApp."
                                name="maxVolume" step="1" value="${this.displayOrder}">
                            </div>

                            <div class="w-1/4 mr-3"></div> <div class="w-1/4"></div>

                        </div>

                        <!-- EXTENDS AUDIO DEVICE  --> 
                        %additionalHtml%
                    </div>

                    <div class="deviceList-modal-footer">
                        
                        
                    </div>
                </div>
            </div>
        </div>

        <!-- ${this.name} -->

        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_draggable}" class="audioDevice-main-card list-group-item fixed" draggable="true">
            <details class="shadow rounded group/audioDevice" data-bs-toggle="modal"
            data-bs-target="#@{_modalAddDevice}">

                <!--    TOP HEADING CONTAINER    -->
                <summary class="audioDevice-summary-container cursor-move">
                    <div class="audioDevice-heading">

                            <!--    NAME AND VOLUME INDICATOR      -->
                            <div class="mb-1 col-span-2">
                                <div class="font-medium text-lg" title="Audio Input Name">${this.name}</div>
                                <div id="@{_volume_slit}" class="audioDevice_volume_slit" title="Audio Indicator"></div>
                            </div>

                            <div class="flex justify-between">
                                <!--    MUTE BUTTON     -->
                                <button id="@{_control_button}" class="audioDevice-btn-mute" type="button" title="If true, reduces the audio volume to zero.">
                                    <span id="@{_control_button_text}">OFF</span>
                                </button>

                                <!--    CONTAINER TOGGLE     -->
                                <div class="audioDevice-toggle-div">
                                    <div class="audioDevice-toggle-arrow"></div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!--    DIVIDER LINE     -->
                <div class="audioDevice-line"></div>

                <!--    MORE INFO CONTAINER       -->
                <div class="audioDevice-more-info-container">

                    

                </div>  
            </details> 
        </div>
        `;
    }

    Init() {
        //Set initial values
        this._setMute();
        this._channels.value = this.channels;
        this._sampleRate.value = this.sampleRate;
        this._bitDepth.value = this.bitDepth;
        this._showVolumeControl.checked = this.showVolumeControl;
        this._showMuteControl.checked = this.showMuteControl;
        this._draggable.style.left = this.left;
        this._draggable.style.top = this.top;

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

            if (this.maxVolume <= this.volume) {
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

        let a = this;
        this._btnDelete.addEventListener('click', (e) => {
            // Show message box
            this.emit('messageBox',
                {
                    buttons: ["Cancel", "Yes"],
                    title: `Delete ${a.name}?`,
                    text: 'Are you sure you want to delete the device?',
                    img: 'bg-delete_bl',
                    callback: function (data) {
                        if (data == 'Yes') {
                            a._notify({ remove: true });
                            a.SetData({ remove: true });
                        }
                    }
                }, 'top');
        });

        this._btnDuplicate.addEventListener('click', (e) => {

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

            this._parent.SetData({ [name]: dup });

            // send newly created audio device's data to manager
            this._parent._notify({ [name]: dup });
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

        // Drag drop

        this._draggable.addEventListener('click', (e) => {
            // scrollTo(0, this.top);

            // this._modalAddDevice.style.top = "50px";
            // this._modalAddDevice.style.left = "50px";
            
            this._modalAddDevice.style.display = "fixed";



             if (this._parent._settingsContainer.style.display = "block")
             {
                this._parent._settingsContainer.style.display = "none";
                this._parent._btnSettings.style.display = "block";
             }

        })

        let isMoving = false;

        function drag_start(event) {
            isMoving = true;
            var style = window.getComputedStyle(event.target, null);
            event.dataTransfer.setData("text/plain",
            (parseInt(style.getPropertyValue("left"),10) - event.clientX) + ',' + (parseInt(style.getPropertyValue("top"),10) - event.clientY));
        } 
        function drag_over(event) { 
            event.preventDefault(); 
            return false; 
        } 
        function drop(event) { 
            if (isMoving)
            {
                var offset = event.dataTransfer.getData("text/plain").split(',');
                a._draggable.style.left = (event.clientX + parseInt(offset[0],10)) + 'px';
                a._draggable.style.top = (event.clientY + parseInt(offset[1],10)) + 'px';

                a.left = (event.clientX + parseInt(offset[0],10)) + 'px';
                a.top = (event.clientY + parseInt(offset[1],10)) + 'px';
                
                a.NotifyProperty("left");
                a.NotifyProperty("top");
                
                event.preventDefault();
                isMoving = false;
                return false;
            }

            
            
        } 
        this._draggable.addEventListener('dragstart',drag_start,false); 
        this._parent._controlsDiv.addEventListener('dragover',drag_over,false); 
        this._parent._controlsDiv.addEventListener('drop',drop,false); 
            
        
        

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