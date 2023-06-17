class SrtOpusInput extends _paAudioSourceBase {
    constructor() {
        super();
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = 10;
        this.srtMaxBw = 8000;   // not implemented in server yet
        this.srtStreamID = '';
    }

    get html() {
        return super.html.replace('%additionalHtml%', `

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

            <!-- SRT Max Bandwidth  --> 
            <div class="w-1/3 flex flex-col">
                <label for="@{_srtMaxBw}" class="form-label inline-block mb-2 mr-2">Max Bw:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_srtMaxBw}" 
                    title="SRT Max Bandwidth in bytes per second" name="SRT MaxBw" step="1" class="srtOpusInput-pos-number-input"
                    value="@{srtMaxBw}"
                >
            </div>

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
            <input id="@{_srtPassphrase}" class="paAudioBase-text-area" type="text" 
            title="SRT encryption passphrase" placeholder="Your srt Passphrase" value="@{srtPassphrase}"/>
        </div>

        <!-- SRT StreamID  -->
        <div class="w-full mb-2">
            <label for="@{_srtStreamID}" class="form-label inline-block mb-2">Stream ID:</label>
                <input id="@{_srtStreamID}" class="paAudioBase-text-area" type="text" 
                title="SRT Stream ID" placeholder="Your srt StreamID" value="@{srtStreamID}"/>
        </div>
        `);
    }


    Init() {
        super.Init();
    }
}