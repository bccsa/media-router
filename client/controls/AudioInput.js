class AudioInput extends ui {
    constructor() {
        super();
        this._styles.push('AudioInput.css');

        this.description = "type your description here";
        this.level = 0;
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.volume = 1;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this._mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;
        this.clientControl = "AudioInputDevice";

        this.peak = 0;
    }

    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="ml-4 mt-2 w-[40rem] overflow-hidden bg-[#1E293B] rounded-lg text-white border-solid border border-b-[#75C4EB]">

            <details class="shadow rounded group">
                <summary class="list-none flex flex-wrap items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[1] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="grid grid-cols-1 sm:grid-cols-4 pt-4 pl-6 w-full h-16 ">
                            <div class="w-1/4">
                                <span class="font-semibold text-lg">${this.name}</span>
                            </div>

                            <div id="${this._uuid}_volume_slit" class="AudioInput_volume_slit">

                            </div>

                            <div class="w-1/4 ml-40">
                            <button type="button" class="inline-block px-6 py-2.5 bg-green-500 text-white font-medium text-xs leading-tight
                             uppercase rounded shadow-md hover:bg-green-600 hover:shadow-lg focus:bg-green-600 focus:shadow-lg focus:outline-none 
                             focus:ring-0 active:bg-green-700 active:shadow-lg transition duration-150 ease-in-out">Off</button>
                            </div>

                            <div class="w-1/4 flex flex-col items-end ml-28">
                                <div class="flex w-10 items-center justify-center">
                                    <div class="border-8 border-transparent border-l-white mr-1 mt-1
                                    group-open:rotate-90 transition-transform origin-left
                                    "></div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!-- More Info Container  -->
                <div id="${this._uuid}_MoreInfoContainer" class="pl-6 pt-4 w-full h-96">

                    <input id="${this._uuid}_description" class="ml-3 w-60 bg-[#293548] text-[#75C4EB] border-solid border border-b-[6A6A6A] rounded-lg" type="text" value="${this.description}"></input>

                    <label for="channel" class="mt-6">Channels:</label>
                    <select id="${this._uuid}_channels" name="channel" class="ml-3 w-50 bg-[#293548] text-[#75C4EB]" type="text">
                    <option value="1">Channel 1</option>
                    <option value="2">Channel 2</option>
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
                    

                    <label for="volume" class="mt-6">Volume:</label>

                    <input type="range" list=tickMarks id="${this._uuid}_volume" name="volume" min="0" max="100" class="ml-3 mt-3 w-64 bg-[#293548] text-[#75C4EB]" oninput="rangeValue.innerText=this.value">
                    
                        <datalist id="tickMarks">
                            <option value="0"></option>
                            <option value="10"></option>
                            <option value="20"></option>
                            <option value="30"></option>
                            <option value="40"></option>
                            <option value="50"></option>
                            <option value="60"></option>
                            <option value="70"></option>
                            <option value="80"></option>
                            <option value="90"></option>
                            <option value="100"></option>
                        </datalist>

                        <p id="rangeValue" class="">10</p>
                    
                </div>  
            </details> 

        </div>`;

    }

 
    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
        this._volume_slit = document.getElementById(`${this._uuid}_volume_slit`);


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

    Update(propertyName) {
        switch (propertyName) {
            case "description":
                this._description.value = this.description;
            default:
                break;
        }
    }


}