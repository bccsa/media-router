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
        <div class="ml-4 mt-2 w-[26rem] overflow-hidden bg-[#1E293B] rounded-lg text-white border-solid border border-b-[#75C4EB]">

            <details class="shadow rounded group">
                <summary class="list-none flex flex-wrap items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[1] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="grid grid-cols-1 sm:grid-cols-3 mt-1 mb-1 ml-3 w-full h-14 ">

                            <!-- Name and Volume indicator -->
                            <div class="w-1/3">
                                <span class="font-semibold text-base">${this.name}</span>

                                <div id="${this._uuid}_volume_slit" class="AudioInput_volume_slit" title="This is a test"></div>

                            </div>

                            <!-- Mute Button -->
                            <div class="ml-32 mt-1">
                                <button id="${this._uuid}_control_button" type="button" class="h-12 w-20 inline-block px-6 py-2.5 leading-tight
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
                        <label for="${this._uuid}_description" class="form-label inline-block mb-2"
                            >Description:</label>
                                <textarea
                                class="
                                    max-h-52
                                    form-control
                                    block
                                    w-11/12
                                    text-base
                                    font-normal
                                    text-gray-700
                                    bg-white bg-clip-padding
                                    border border-solid border-gray-300
                                    rounded
                                    transition
                                    ease-in-out
                                    focus:text-gray-700 focus:bg-white focus:border-blue-600 focus:outline-none"

                                    id="${this._uuid}_description"
                                    rows="2" 
                                    cols="3"
                                    placeholder="Your description" 
                                ></textarea>
                    </div>

                    <!-- Volume Slider  -->
                    <div class="w-full mb-2">

                        <label for="${this._uuid}_volume" class="mt-6">Volume:</label>

                        <div class="container">
                            

                            <input type="range" list=tickMarks id="${this._uuid}_volume_slider" name="volume" step="0.01" min="0" max="${this.maxVolume}" value="${this.volume}" class="ml-4 mt-6 w-64 bg-[#293548] text-[#75C4EB]" oninput=""${this._uuid}_rangeValue".innerText=this.value">
                            
                            <datalist id="tickMarks">
                                <option value="0.0"></option>
                                <option value="0.10"></option>
                                <option value="0.20"></option>
                                <option value="0.30"></option>
                                <option value="0.40"></option>
                                <option value="0.50"></option>
                                <option value="0.60"></option>
                                <option value="0.70"></option>
                                <option value="0.80"></option>
                                <option value="0.90"></option>
                                <option value="1.0" label="100%"></option>
                                <option value="1.10"></option>
                                <option value="1.20"></option>
                                <option value="1.30"></option>
                                <option value="1.40"></option>
                                <option value="1.50"></option>
                            </datalist>

                            <span id="${this._uuid}_rs-bullet" class="">100</span>
                            
                        </div>

                        
                    </div>



                    <label for="channel" class="mt-6">Channels:</label>
                    <select id="${this._uuid}_channels" name="channel" class="ml-3 w-50 bg-[#293548] text-[#75C4EB]" type="text">
                    <option value="1">1</option>
                    <option value="2">2</option>
                    </select>

                    <label for="sampleRate" class="ml-3 mt-6">Sample Rate:</label>
                    <select id="${this._uuid}_sampleRate" name="sampleRate" class="ml-3 w-50 bg-[#293548] text-[#75C4EB]" type="text">
                            <option value="1">44100 Hz</option>
                            <option value="2">48000 Hz</option>
                    </select>

                    <label for="bitDepth" class="ml-3 mt-6">Bit Depth:</label>
                    <select id="${this._uuid}_bitDepth" name="bitDepth" class="ml-3 w-50 bg-[#293548] text-[#75C4EB]" type="text">
                        <option value="1">16</option>
                        <option value="2">24</option>
                        <option value="3">32</option>
                    </select>
                    

                    
                    
                </div>  
            </details> 

        </div>`;

    }

 
    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
        this._volume_slit = document.getElementById(`${this._uuid}_volume_slit`);
        this._control_button = document.getElementById(`${this._uuid}_control_button`);
        this._control_button_text = document.getElementById(`${this._uuid}_control_button_text`);


        this.rangeSlider = document.getElementById(`${this._uuid}_volume_slider`);
        this.rangeBullet = document.getElementById(`${this._uuid}_rs-bullet`);




        //Set initial mute status
        this._setMute();

        //Event subscriptions
        this._control_button.addEventListener('click', (e) => {
            this.mute = !this.mute;

            this._setMute();
            this.NotifyProperty("mute");
        });

        this.rangeSlider.addEventListener('input', (e) => {
            this.showSliderValue();
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
        this.rangeBullet.innerHTML = Math.round(this.rangeSlider.value * 100);
        var bulletPosition = (this.rangeSlider.value /this.rangeSlider.max);
        this.rangeBullet.style.left = (bulletPosition * 50) + "px";
    }

}