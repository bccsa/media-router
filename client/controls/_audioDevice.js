class _audioDevice extends ui {
    constructor() {
        super();
        this._styles.push('AudioInput.css');
        

        this.level = 0;
        this.mute = true;

        this.description = "";

        this.volume = 1;

        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.maxVolume = 1.5;

        this.destinations = ["Destination1","Destination2","Destination3"]; // Split with comma from string

        this.soloGroup = "";
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;

        this.device = 'default';
        this.peak = 0;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="main-card">
        

            <details class="shadow rounded group">
                <summary class="list-none flex items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[10] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="grid grid-cols-3 mt-1 mb-1 ml-4 pl-2 w-full h-14">

                            <!-- Name and Volume indicator -->
                            <div class="w-1/3">
                                <span class="font-semibold text-base" title="Audio Input Name">${this.name}</span>

                                <div id="${this._uuid}_volume_slit" class="AudioInput_volume_slit" title="Audio Indicator"></div>

                            </div>

                            <!-- Mute Button -->
                            <div class="ml-[10.5rem] mt-2">
                                <button id="${this._uuid}_control_button" type="button" title="Mute Button" class="h-10 w-20 inline-block px-6 py-2.5 leading-tight
                                    uppercase rounded hover:bg-green-600 hover:shadow-lg focus:bg-green-600 focus:shadow-lg focus:outline-none 
                                    focus:ring-0 transition duration-150 ease-in-out">
                                    <span id="${this._uuid}_control_button_text">OFF</span>
                                </button>
                            </div>

                            <!-- Container toggle -->
                            <div class="w-1/4 flex flex-col items-end ml-28">
                                <div id="${this._uuid}_container_toggle" class="flex w-10 items-center justify-center">
                                    <div class="border-8 border-transparent border-l-white mr-1 mt-1
                                    group-open:rotate-90 transition-transform origin-left
                                    "></div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#75C4EB]"></div>

                <!-- More Info Container  -->
                <div class="p-6 pt-2 w-full h-auto">

                    <!-- Description text area  -->
                    <div class="w-full mb-1 mr-4">
                        <label for="${this._uuid}_description" class="form-label inline-block mb-2">Description:</label>
                            <textarea
                                class="max-h-40 min-h-[2rem] mr-4 form-control block w-full max-w-[27.5rem] text-base font-normal
                                text-[#75C4EB] bg-[#293548] border border-solid border-gray-300
                                rounded transition ease-in-out focus:bg-[#2B3749] focus:border-blue-600 
                                focus:outline-none px-2 py-1"

                                id="${this._uuid}_description"
                                title="Device description"
                                rows="1" 
                                cols="3"
                                placeholder="Your description" 
                            >${this.description}</textarea>
                    </div>

                    <!-- Volume Slider  -->
                    <div class="w-full mb-1">

                        <label for="${this._uuid}_volume" class="mt-6">Volume:</label>

                        <input type="range" list="${this._uuid}_tickMarks" id="${this._uuid}_volume_slider" title="Audio volume" name="volume" step="0.01" min="0" max="${this.maxVolume}" value="${this.volume}" class="ml-4 mt-2 w-60 bg-[#293548] text-[#75C4EB]" oninput=""${this._uuid}_rangeValue".innerText=this.value">
                        
                        <datalist id="${this._uuid}_tickMarks">
                            <option value="0.00"></option>
                            <option value="0.10"></option>
                            <option value="0.20"></option>
                            <option value="0.30"></option>
                            <option value="0.40"></option>
                            <option value="0.50"></option>
                            <option value="0.60"></option>
                            <option value="0.70"></option>
                            <option value="0.80"></option>
                            <option value="0.90"></option>
                            <option value="1.0"0></option>
                            <option value="1.10"></option>
                            <option value="1.20"></option>
                            <option value="1.30"></option>
                            <option value="1.40"></option>
                            <option value="1.50"></option>
                        </datalist>

                        <span id="${this._uuid}_rs-bullet" class="ml-2 mb-20">100 %</span>
                          
                    </div>

                    <div class="w-full mb-1 flex ">

                        <!-- Channels  -->
                        <div class="w-1/4 mr-3">
                            <label for="${this._uuid}_channels" class="form-label inline-block mb-2">Channels:</label>
                                <div class="mb-3 w-full">
                                    <select id="${this._uuid}_channels" title="Choose the channel" value="${this.channels}" name="channel" class="form-select
                                    w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                    border border-solid border-gray-300 rounded transition
                                    ease-in-out focus:bg-[#2B3749] focus:border-blue-600 pl-1.5"
                                    type="text">
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    </select>
                                </div>
                        </div>
                        
                        <!-- SampleRate  -->
                        <div class="w-1/4 mr-3">
                            <label for="${this._uuid}_sampleRate" class="form-label inline-block mb-2">Sample Rate:</label>
                            <select id="${this._uuid}_sampleRate" title="Choose the sample rate" value="${this.sampleRate}" name="sampleRate" class="form-select
                                w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                border border-solid border-gray-300 rounded transition
                                ease-in-out focus:bg-[#2B3749] focus:border-blue-600 pl-1" type="text">
                                <option value="44100">44100 Hz</option>
                                <option value="48000">48000 Hz</option>
                            </select>
                        </div>

                        <!-- BitDepth  -->    
                        <div class="w-1/4 mr-3">
                            <label for="${this._uuid}_bitDepth" class="form-label inline-block mb-2">Bit Depth:</label>
                            <select id="${this._uuid}_bitDepth" title="Choose the bit depth" value="${this.bitDepth}" name="bitDepth" class="form-select
                                w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                border border-solid border-gray-300 rounded transition
                                ease-in-out focus:bg-[#2B3749] focus:border-blue-600 pl-1.5" type="text">
                                <option value="16">16</option>
                                <option value="24">24</option>
                                <option value="32">32</option>
                            </select>
                        </div>

                        <!-- Max Volume  --> 
                        <div class="w-1/4">
                            <label for="${this._uuid}_maxVolume" class="form-label inline-block mb-2">Max Volume:</label>
                            <input type="number" min="0" oninput="validity.valid||(value='')" id="${this._uuid}_maxVolume" title="Enter the max volume" name="maxVolume" step="0.1" class="
                                w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                border border-solid border-gray-300 rounded transition
                                ease-in-out focus:bg-[#2B3749] focus:border-blue-600 pl-1.5"
                                value="${this.maxVolume}"
                            >
                        </div>

                    </div>

                    <!-- Destinations  -->
                    <div class="w-full mb-1 mr-4">
                        <label for="${this._uuid}_destinations" class="form-label inline-block mb-2">Destinations:</label>
                            <textarea
                                class="max-h-40 min-h-[2rem] mr-4 form-control block w-full max-w-[27.5rem] text-base font-normal
                                text-[#75C4EB] bg-[#293548] border border-solid border-gray-300
                                rounded transition ease-in-out focus:bg-[#2B3749] focus:border-blue-600 
                                focus:outline-none px-2 py-1"

                                id="${this._uuid}_destinations"
                                title="Enter the destinations, e.g. 'D1, D2, D3'"
                                rows="1" 
                                cols="3"
                                placeholder="Example: Destination1, Destination2, Destination3"
                            ></textarea>
                    </div>

                    <!-- Solo Group  -->
                    <div class="w-full mb-1 mr-4">
                        <label for="${this._uuid}_soloGroup" class="form-label inline-block mb-2">Solo Group:</label>
                            <textarea
                                class="max-h-40 min-h-[2rem] mr-4 form-control block w-full max-w-[27.5rem] text-base font-normal
                                text-[#75C4EB] bg-[#293548] border border-solid border-gray-300
                                rounded transition ease-in-out focus:bg-[#2B3749] focus:border-blue-600 
                                focus:outline-none px-2 py-1"

                                id="${this._uuid}_soloGroup"
                                title="Enter solo group name";
                                rows="1" 
                                cols="3"
                                placeholder="Solo group name:"
                            ></textarea>
                    </div>

                    <!-- Show Volume Control Checkbox  --> 
                    <div class="w-full mb-1 flex">
                        <input type="checkbox" checked id="${this._uuid}_showVolumeControl" value="" class="mr-2 mt-1 h-4 w-4" />  
                        <label for="${this._uuid}_showVolumeControl" class="form-label inline-block">Show client volume control</label> 
                    </div>

                    <!-- Show Mute Control Checkbox  --> 
                    <div class="w-full mb-1 flex">
                        <input type="checkbox" checked id="${this._uuid}_showMuteControl" value="" class="mr-2 mt-1 h-4 w-4" />  
                        <label for="${this._uuid}_showMuteControl" class="form-label inline-block">Show client mute control</label>  
                    </div>

                    <!-- Display Order  --> 
                    <div class="w-full mr-4 mt-1 flex">
                        <label for="${this._uuid}_displayOrder" class="form-label inline-block mb-2 mr-2">Display Order:</label>
                        <input type="number" min="0" oninput="validity.valid||(value='')" id="${this._uuid}_displayOrder" title="Client display order" name="maxVolume" step="1" class="
                            w-1/5 h-6 text-base font-normal text-[#75C4EB] bg-[#293548]
                            border border-solid border-gray-300 rounded transition
                            ease-in-out focus:bg-[#2B3749] focus:border-blue-600 pl-1.5 py-1"
                            value="${this.displayOrder}"
                        >
                    </div>
                    <div id="${this._uuid}_controlsDiv"/>
                </div>  
            </details> 

        </div>`;

    }

 
    Init() {
        
        this._volume_slit = document.getElementById(`${this._uuid}_volume_slit`);
        this._control_button = document.getElementById(`${this._uuid}_control_button`);
        this._control_button_text = document.getElementById(`${this._uuid}_control_button_text`);

        this._description = document.getElementById(`${this._uuid}_description`);
        this._volume_slider = document.getElementById(`${this._uuid}_volume_slider`);
        this._rangeBullet = document.getElementById(`${this._uuid}_rs-bullet`);

        this._channels = document.getElementById(`${this._uuid}_channels`);
        this._sampleRate = document.getElementById(`${this._uuid}_sampleRate`);
        this._bitDepth = document.getElementById(`${this._uuid}_bitDepth`);
        this._maxVolume = document.getElementById(`${this._uuid}_maxVolume`);

        this._destinations = document.getElementById(`${this._uuid}_destinations`);
        this._soloGroup = document.getElementById(`${this._uuid}_soloGroup`);

        this._showVolumeControl = document.getElementById(`${this._uuid}_showVolumeControl`);
        this._showMuteControl = document.getElementById(`${this._uuid}_showMuteControl`);
        this._displayOrder = document.getElementById(`${this._uuid}_displayOrder`);

        this._controlsDiv = document.getElementById(`${this._uuid}_controlsDiv`);

        //Set initial mute status
        this._setMute();

        //Event subscriptions
        this._control_button.addEventListener('click', (e) => {
            this.mute = !this.mute;

            this._setMute();
            this.NotifyProperty("mute");
        });

        this._description.addEventListener('change', (e) => {
            this.description = this._description.value;
        });

        this._volume_slider.addEventListener('input', (e) => {
            this.showSliderValue();
        });

        this._channels.addEventListener('change', (e) => {
            this.channels = Number.parseInt(this._channels.value);
        });

        this._sampleRate.addEventListener('change', (e) => {
            this.sampleRate = Number.parseInt(this._sampleRate.value);
        });

        this._bitDepth.addEventListener('change', (e) => {
            this.bitDepth = Number.parseInt(this._bitDepth.value);
        });

        this._maxVolume.addEventListener('change', (e) => {
            this.maxVolume = Number.parseFloat(this._maxVolume.value);
            this._volume_slider.max = this.maxVolume;
            this.showSliderValue();
        });

        this._destinations.addEventListener('change', (e) => {
            this.destinations = this._destinations.value.split(', ');
        });

        this._soloGroup.addEventListener('change', (e) => {
            this.soloGroup = this._soloGroup.value;
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
        });

        this.on('destinations', () => {
            this._setDestinations()
        });

        this.on('soloGroup', soloGroup => {
            this._soloGroup.value = soloGroup;
        });

        this.on('showVolumeControl', showVolumeControl => {
            this._showVolumeControl.value = showVolumeControl;
        });

        this.on('showMuteControl', showMuteControl => {
            this._showMuteControl.value = showMuteControl;
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
    }

    showSliderValue() {
        this._rangeBullet.innerHTML = Math.round(this._volume_slider.value * 100) + " %";
    }

    _setDestinations(){
        this._destinations.value = this.destinations.join(', ');
    }

}