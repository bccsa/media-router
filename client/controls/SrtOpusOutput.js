class SrtOpusOutput extends _uiClasses(_paAudioSinkBase, SrtBase) {
    constructor() {
        super();
        // Encoder Settings
        this.fec = false;           // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this.complexity = 10;       // Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.bitrate = 64;          // Opus encoding target bitrate in kbps
        this.srtEnableMaxBW = true; // Enable MaxBandwidth property for srt  
    }

    get html() {
        return super.html.replace('%additionalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Encoder Settings</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable OPUS Forward Error Correction      --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_showFec}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{fec}"/>  
                <label for="@{_showFec}" class="" title="Enable opus Forward Error Correction">Enable opus Forward Error Correction</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div class="w-full mb-4 flex ">
            <!-- FEC PacketLoss --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_fecPacketLoss}" class="form-label inline-block mb-2 mr-2">FEC packet loss:</label>
                <input type="number" min="0" max="100" oninput="validity.valid||(value='')" id="@{_fecPacketLoss}" 
                    title="Opus FEC packet loss percentage (preset value)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{fecPacketLoss}"
                >
            </div>

            <!-- complexity  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_complexity}" class="form-label inline-block mb-2 mr-2">Complexity level:</label>
                <input type="number" min="0" max="10" oninput="validity.valid||(value='')" id="@{_complexity}" 
                    title="Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality." step="1" class="srtOpusInput-pos-number-input"
                    value="@{complexity}"
                >
            </div>

            <!-- Bitrate -->
            <div class="w-1/3 flex flex-col">
                <label for="@{_bitrate}" class="form-label inline-block mb-2">Bitrate:</label>
                <select id="@{_bitrate}" title="Opus encoding target bitrate in kbps" value="@{bitrate}" 
                class="paAudioBase-select" type="text">
                    <option value="320">320</option>
                    <option value="256">256</option>
                    <option value="224">224</option>
                    <option value="192">192</option>
                    <option value="160">160</option>
                    <option value="144">144</option>
                    <option value="128">128</option>
                    <option value="112">112</option>
                    <option value="96">96</option>
                    <option value="80">80</option>
                    <option value="64">64</option>
                    <option value="56">56</option>
                    <option value="48">48</option>
                    <option value="40">40</option>
                    <option value="32">32</option>
                    <option value="24">24</option>
                    <option value="16">16</option>
                    <option value="8">8</option>
                </select>
            </div>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        ${this.SrtBaseHtml()}
        `).replace("<!--  %SrtStatsHtml%  -->", this.SrtStatsHtml());
    }

    Init() {
        super.Init();
        this.setHeaderColor('#00C3A3');

        // init SRT Spesific
        this._SrtInit();

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SrtOpusOutput.md');
        //----------------------Help Modal-----------------------------//
    }
}