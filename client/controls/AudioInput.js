class AudioInput extends ui {
    constructor() {
        super();
        this.description = "type your description here";
        this._styles.push('AudioInput.css');
    }

    /*
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this._mute = true;
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayOrder = 0;
        this.clientControl = "AudioInputDevice";
       */

    get html() {
        return `
        <!-- ${this.name} -->


        <!-- Main Card Container -->
        <div class="ml-4 mt-4 w-[42rem] bg-white shadow-lg rounded-lg overflow-hidden">

            <!-- Top Heading Container  -->
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-x-2 gap-y-3 pt-4 pl-6 w-full h-36 bg-[#1E293B] rounded-t-lg text-white border-solid border border-b-[#75C4EB]">
                    <div class="w-1/3">
                        <span class="font-semibold text-lg">${this.name}</span>
                    </div>
                    <div class="w-1/3">
                        <input type="range" list=tickMarks id="${this._uuid}_volume" name="volume" min="0" max="100" class="ml-3 mt-3 w-64 bg-[#293548] text-[#75C4EB]" oninput="rangeValue.innerText=this.value">
                    </div>
                    <div class="w-1/3 flex flex-col items-end ml-32">
                        <button onclick="toggleContainer('${this._uuid}_MoreInfoContainer')" class="">ᐯ</button>
                    </div>

                    <div class="col-span-2">

                    
                    <!--  <input type="checkbox" name="un-mute" id="un-mute">
                        <label for="un-mute" class="unmute">
                            <img src="http://upload.wikimedia.org/wikipedia/commons/3/3f/Mute_Icon.svg" alt="Mute_Icon.svg" title="Mute icon">
                        </label>
                        <label for="un-mute" class="mute">
                            <img src="http://upload.wikimedia.org/wikipedia/commons/2/21/Speaker_Icon.svg" alt="Speaker_Icon.svg" title="Unmute/speaker icon">
                    </label>-->
                        

                         
                    </div>

                    <div class="">
                        <p id="rangeValue" class="">mute</p>
                    </div>
                    

            </div>

            
            <!-- More Info Container  -->
            <div id="${this._uuid}_MoreInfoContainer" class="pl-6 pt-4 w-full h-96 bg-[#1E293B] text-white indent-2.5 border border-solid  border-t-0 border-b-[#1E293B] ">

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
    
        </div>`;

    }

 
    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
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