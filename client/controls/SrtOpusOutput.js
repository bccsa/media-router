class SrtOpusOutput extends _paAudioSinkBase {
    constructor() {
        super();
        // Encoder Settings
        this.fec = false;            // Enable opus Forward Error Correction
        this.fecPacketLoss = 5;     // Opus FEC packet loss percentage (preset value)
        this.compression = 10;      // Opus compression level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality.
        this.bitrate = 64;          // Opus encoding target bitrate in kbps

        // SRT Settings
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = 10;
        this.srtStreamID = ''
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

        <div class="w-full mb-2 flex ">
            <!-- FEC PacketLoss --> 
            <div class="w-1/2 mr-4 flex flex-col">
                <label for="@{_fecPacketLoss}" class="form-label inline-block mb-2 mr-2">FEC packet loss:</label>
                <input type="number" min="0" max="100" oninput="validity.valid||(value='')" id="@{_fecPacketLoss}" 
                    title="Opus FEC packet loss percentage (preset value)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{fecPacketLoss}"
                >
            </div>

            <!-- Compression  --> 
            <div class="w-1/2 flex flex-col">
                <label for="@{_compression}" class="form-label inline-block mb-2 mr-2">Compression level:</label>
                <input type="number" min="0" max="10" oninput="validity.valid||(value='')" id="@{_compression}" 
                    title="Opus compression level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality." step="1" class="srtOpusInput-pos-number-input"
                    value="@{compression}"
                >
            </div>

        </div>

        <div class="w-full mb-2 flex ">
            <!-- Bitrate -->
            <div class="w-1/3 mr-4 flex flex-col">
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

            <div class="w-1/3 mr-4 "></div>

            <div class="w-1/3"></div>
        </div>


        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">SRT Settings</div>
        </div>
    
        <!-- SRT host  -->
        <div class="w-full mb-2">
            <label for="@{_srtHost}" class="form-label inline-block mb-2">Host:</label>
                <input id="@{_srtHost}" class="paAudioBase-text-area" type="text"
                title="SRT host name / ip address" placeholder="Your srt Host" value="@{srtHost}"/>
        </div>

        <div class="w-full mb-2 flex ">
            <!-- SRT port  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_srtPort}" class="form-label inline-block mb-2 mr-2">Port:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_srtPort}" 
                    title="SRT port" name="SRT port" step="1" class="srtOpusInput-pos-number-input"
                    value="@{srtPort}"
                >
            </div>

            <!-- SRT Latency  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_srtLatency}" class="form-label inline-block mb-2 mr-2">Latency:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_srtLatency}" 
                    title="SRT latency in milliseconds" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="@{srtLatency}"
                >
            </div>

            <div class="w-1/3"></div>

        </div>

        <div class="w-full mb-2 flex ">

            <!-- SRT Mode  -->    
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_srtMode}" class="form-label inline-block mb-2">Mode:</label>
                <select id="@{_srtMode}" title="SRT mode (caller, listener, rendezvous)" value="@{srtMode}" 
                name="SRT Mode" class="paAudioBase-select" type="text">
                    <option value="caller">Caller</option>
                    <option value="listener">Listener</option>
                    <option value="rendezvous">Rendezvous</option>
                </select>
            </div>

            <!-- SRT PbKeyLen  -->    
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_srtPbKeyLen}" class="form-label inline-block mb-2">Pb Key Length:</label>
                <select id="@{_srtPbKeyLen}" title="SRT encryption key length (16, 32)" value="@{srtPbKeyLen}" 
                name="SRT PbKeyLen" class="paAudioBase-select" type="text">
                    <option value="16">16</option>
                    <option value="32">32</option>
                </select>
            </div>

            <div class="w-1/3"></div>

        </div>

        <!-- SRT Passphrase  -->
        <div class="w-full mb-2">
            <label for="@{_srtPassphrase}" class="form-label inline-block mb-2">Passphrase:</label>
                <input id="@{_srtPassphrase}" class="paAudioBase-text-area" type="text" title="SRT encryption passphrase"
                placeholder="Your srt Passphrase" value="@{srtPassphrase}"/>
        </div>

        <!-- SRT StreamID  -->
        <div class="w-full mb-2">
            <label for="@{_srtStreamID}" class="form-label inline-block mb-2">Stream ID:</label>
                <input id="@{_srtStreamID}" class="paAudioBase-text-area" type="text" title="SRT Stream ID"
                placeholder="Your srt StreamID" value="@{srtStreamID}"/>
        </div>
        `);
    }

    Init() {
        super.Init();
        this.setHeaderColor('#00C3A3');
    }
}