class AudioInput extends ui {
    constructor() {
        super();
        this._styles.push('AudioInput.css');

        this.description = "";
        this.level = 0;
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.volume = 1;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this.mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;
        this.device = 'default';
        this.destinations = ["Destination1","Destination2","Destination3"]; // Split with comma from string
        this.peak = 0;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="ml-4 mt-2 w-[30rem] overflow-hidden bg-[#1E293B] rounded-lg text-white border-solid border border-b-[#75C4EB]">

            <details class="shadow rounded group">
                <summary class="list-none flex flex-wrap items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[1] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="grid grid-cols-1 sm:grid-cols-3 mt-1 mb-1 ml-3 w-full h-14 ">

                            <!-- Name and Volume indicator -->
                            <div class="w-1/3">
                                <span class="font-semibold text-base" title="Audio Input Name">${this.name}</span>

                                <div id="${this._uuid}_volume_slit" class="AudioInput_volume_slit" title="Audio Indicator"></div>

                            </div>

                            <!-- Mute Button -->
                            <div class="ml-32 mt-1">
                                <button id="${this._uuid}_control_button" type="button" title="Mute Button" class="h-12 w-20 inline-block px-6 py-2.5 leading-tight
                                    uppercase rounded hover:bg-green-600 hover:shadow-lg focus:bg-green-600 focus:shadow-lg focus:outline-none 
                                    focus:ring-0 transition duration-150 ease-in-out">
                                    <span id="${this._uuid}_control_button_text">OFF</span>
                                </button>
                            </div>

                            <!-- Container toggle -->
                            <div class="w-1/4 flex flex-col items-end ml-28">
                                <div class="flex w-10 items-center justify-center">
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
                <div class="pl-6 pt-4 w-full h-96">

                    <!-- Description text area  -->
                    <div class="w-full mb-2">
                        <label for="${this._uuid}_description" class="form-label inline-block mb-2">Description:</label>
                            <textarea
                                class="max-h-52 form-control block w-11/12 text-base font-normal
                                text-gray-700 bg-white bg-clip-padding border border-solid border-gray-300
                                rounded transition ease-in-out focus:text-gray-700 focus:bg-white focus:border-blue-600 
                                focus:outline-none"

                                id="${this._uuid}_description"
                                rows="2" 
                                cols="3"
                                placeholder="Your description" 
                            ></textarea>
                    </div>

                    <!-- Volume Slider  -->
                    <div class="w-full mb-2">

                        <label for="${this._uuid}_volume" class="mt-6">Volume:</label>

                        <input type="range" list="${this._uuid}_tickMarks" id="${this._uuid}_volume_slider" name="volume" step="0.01" min="0" max="${this.maxVolume}" value="${this.volume}" class="ml-4 mt-2 w-60 bg-[#293548] text-[#75C4EB]" oninput=""${this._uuid}_rangeValue".innerText=this.value">
                        
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

                        <span id="${this._uuid}_rs-bullet" class="ml-2 mb-20">100</span>
                          
                    </div>

                    <div class="w-full mb-2 flex ">

                        <div class="w-1/4 mr-4">
                            <label for="${this._uuid}_channels" class="form-label inline-block mb-2">Channels:</label>
                                <div class="mb-3 w-full">
                                    <select id="${this._uuid}_channels" value="${this.channels}" name="channel" class="form-select
                                    w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                    border border-solid border-gray-300 rounded transition
                                    ease-in-out m-0"
                                    type="text">
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    </select>
                                </div>
                        </div>
                            
                        <div class="w-1/4 mr-4">
                            <label for="${this._uuid}_sampleRate" class="form-label inline-block mb-2">Sample Rate:</label>
                            <select id="${this._uuid}_sampleRate" value="${this.sampleRate}" name="sampleRate" class="form-select
                                w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                border border-solid border-gray-300 rounded transition
                                ease-in-out m-0" type="text">
                                <option value="44100">44100 Hz</option>
                                <option value="48000">48000 Hz</option>
                            </select>
                        </div>
                            
                        <div class="w-1/4 mr-4">
                            <label for="${this._uuid}_bitDepth" class="form-label inline-block mb-2">Bit Depth:</label>
                            <select id="${this._uuid}_bitDepth" value="${this.bitDepth}" name="bitDepth" class="form-select
                                w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                border border-solid border-gray-300 rounded transition
                                ease-in-out m-0" type="text">
                                <option value="16">16</option>
                                <option value="24">24</option>
                                <option value="32">32</option>
                            </select>
                        </div>

                        <div class="w-1/4 mr-4">
                            <label for="${this._uuid}_maxVolume" class="form-label inline-block mb-2">Max Volume:</label>
                            <input type="number" id="${this._uuid}_maxVolume" name="maxVolume" step="0.1" class="
                                w-full text-base font-normal text-[#75C4EB] bg-[#293548]
                                border border-solid border-gray-300 rounded transition
                                ease-in-out m-0"
                                value="${this.maxVolume}"
                            >
                        </div>

                    </div>


                    
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


        //Set initial mute status
        this._setMute();

        //Event subscriptions
        this._control_button.addEventListener('click', (e) => {
            this.mute = !this.mute;

            this._setMute();
            this.NotifyProperty("mute");
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
        this.on('description', () => {
            _setDescription()
        });

        this.on('mute', () => {
            this._setMute();
        });

        this.on('volume', () => {
            this._setVolume();
        });

        this.on('level', level => {
            if (this.vu) {
                this.vu.level = level;
            }
        });
    }

    
    _setDescription(){
        this._description.value = this.description;
    }

    _setVolume() {
        if (!this._sliderActive) {
            this._volume_slider.style.top = `${this._sliderBottom - this.volume / this.maxVolume * this._sliderRange}px`;
        }
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

    showSliderValue() {
        this._rangeBullet.innerHTML = Math.round(this._volume_slider.value * 100);
    }

}