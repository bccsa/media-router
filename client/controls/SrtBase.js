class SrtBase {
    constructor() {
        this.srtHost = '';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = 10;
        this.srtMaxBw = 250;   // % of Bandwidth
        this.srtEnableMaxBW = false; // Enable MaxBandwidth property for srt 
        this.srtStreamID = '';
        this.caller_count = 0;      // amount of callers connected to module
    }

    SrtBaseHtml(title = "SRT Settings", 
        prop_host = "srtHost", 
        prop_port = "srtPort", 
        prop_mode = "srtMode", 
        porp_PbKeyLen = "srtPbKeyLen", 
        prop_passphrase = "srtPassphrase", 
        prop_latency = "srtLatency", 
        prop_maxBw = "srtMaxBw", 
        prop_enableMaxBw = "srtEnableMaxBW", 
        prop_streamId = "srtStreamID"
    ) {
        return `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">${title}</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable SRT Max Bandwidth      --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_${prop_enableMaxBw}}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{${prop_enableMaxBw}}"/>  
                <label for="@{_${prop_enableMaxBw}}" class="" title="Enable SRT max bandwidth">Enable SRT max bandwidth</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <!-- SRT host  -->
        <div class="w-full mb-2">
            <label for="@{_${prop_host}}" class="form-label inline-block mb-2">Host:</label>
                <input id="@{_${prop_host}}" class="paAudioBase-text-area" type="text"
                title="SRT host name / ip address" placeholder="Your srt Host" value="@{${prop_host}}"/>
        </div>

        <div class="w-full mb-2 flex ">
            <!-- SRT port  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_${prop_port}}" class="form-label inline-block mb-2 mr-2">Port:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_${prop_port}}" 
                    title="SRT port" name="SRT port" step="1" class="srtOpusInput-pos-number-input"
                    value="@{${prop_port}}"
                >
            </div>

            <!-- SRT Latency  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_${prop_latency}}" class="form-label inline-block mb-2 mr-2">Latency:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_${prop_latency}}" 
                    title="SRT latency in milliseconds" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="@{${prop_latency}}"
                >
            </div>

            <!-- SRT Max Bandwidth  --> 
            <div class="w-1/3 flex flex-col">
                <div id=@{${prop_maxBw}_div}>
                    <label for="@{_${prop_maxBw}}" class="form-label inline-block mb-2 mr-2">Max Bw (% of BW):</label>
                    <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_${prop_maxBw}}" 
                        title="SRT Max Bandwidth in bytes per second" name="SRT MaxBw" step="1" min="100" max="1000" class="srtOpusInput-pos-number-input"
                        value="@{${prop_maxBw}}"
                    >
                </div>
            </div>

        </div>

        <div class="w-full mb-2 flex ">

            <!-- SRT Mode  -->    
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_${prop_mode}}" class="form-label inline-block mb-2">Mode:</label>
                <select id="@{_${prop_mode}}" title="SRT mode (caller, listener, rendezvous)" value="@{${prop_mode}}" 
                name="SRT Mode" class="paAudioBase-select" type="text">
                    <option value="caller">Caller</option>
                    <option value="listener">Listener</option>
                    <option value="rendezvous">Rendezvous</option>
                </select>
            </div>

            <!-- SRT PbKeyLen  -->    
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_${porp_PbKeyLen}}" class="form-label inline-block mb-2">Pb Key Length:</label>
                <select id="@{_${porp_PbKeyLen}}" title="SRT encryption key length (16, 32)" value="@{${porp_PbKeyLen}}" 
                name="SRT PbKeyLen" class="paAudioBase-select" type="text">
                    <option value="16">16</option>
                    <option value="32">32</option>
                </select>
            </div>

            <!-- Place holder  --> 
            <div class="w-1/3 flex flex-col"></div>

        </div>

        <!-- SRT Passphrase  -->
        <div class="w-full mb-2">
            <label for="@{_${prop_passphrase}}" class="form-label inline-block mb-2">Passphrase:</label>
            <input id="@{_${prop_passphrase}}" class="paAudioBase-text-area" type="text" 
            title="SRT encryption passphrase" placeholder="Your srt Passphrase" value="@{${prop_passphrase}}"/>
        </div>

        <!-- SRT StreamID  -->
        <div class="w-full mb-2">
            <label for="@{_${prop_streamId}}" class="form-label inline-block mb-2">Stream ID:</label>
                <input id="@{_${prop_streamId}}" class="paAudioBase-text-area" type="text" 
                title="SRT Stream ID" placeholder="Your srt StreamID" value="@{${prop_streamId}}"/>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 
        `
    }

    SrtStatsHtml() {
        return `
        <!--  Srt Stats section  -->
        <div id="@{_modalSrtStats}" class="paAudioBase-sub-modal hidden">

            <div class="paAudioBase-modal-header">
                <div class="flex flex-shrink-0 items-center justify-between">
                    <span class="appFrame-control-name">SRT Stats</span>
                    <span id="@{_callerCount}" class="appFrame-control-name">Callers: <span>@{caller_count}</span></span>
                </div>
            </div>

            <div class="paAudioBase-modal-body">
                <div id="@{_modalSrtStats_table_cols}">
                    <!-- SRT Controls div -->
                    <div class="text-sm text-left grid grid-cols-8">
                        <div class="border px-4 py-2">
                            Stats ID
                        </div>
                        <div class="border px-4 py-2">
                            Send/ Receive Rate (Mbps)
                        </div>
                        <div class="border px-4 py-2">
                            Packet Loss (%)
                        </div>
                        <div class="border px-4 py-2">
                            Data Send/ Receive (MB)
                        </div>
                        <div class="border px-4 py-2">
                            Roudtrip time (ms)
                        </div>
                        <div class="border px-4 py-2">
                            Available Bandwidth (Mbps)
                        </div>
                        <div class="border px-4 py-2">
                            Send Duration
                        </div>
                        <div class="border px-4 py-2">
                            Status
                        </div>
                    </div>
                    <div id="@{_SrtStatsDiv}"></div>
                </div>
            </div>
        </div>
        `
    }

    /**
     * Initialize SRT spesific 
     */
    _SrtInit() {
        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SrtBase.md'); // Load aditional MD
        //----------------------Help Modal-----------------------------//

        // Display Srt stats button
        this._btnSrtStats.style.display = 'block';

        //----------------------SrtStats Modal-----------------------------//
        this._modalSrtStats.style.display = 'none';   
        this._btnSrtStats.addEventListener('click', e => {
            this._modalSrtStats.style.display = "block";
            this._SettingsContent.style.display = "none";
            this._modalHelp.style.display = "none";
        })
        this._btnSettings.addEventListener('click', e => {
            this._modalSrtStats.style.display = "none";
            this._SettingsContent.style.display = "block";
        })
        //----------------------SrtStats Modal-----------------------------//

        //----------------------SrtStats Modification-----------------------------//
        this.on("srtMode", mode => {
            if (mode == "listener") {
                this._callerCount.style.display = "block";
            } else {
                this._callerCount.style.display = "none";
            }
        }, { immediate: true });

        this.on("caller_count", (_c) => { 
            if (_c == 0)
                this._SrtConnectionStat("disconnected");
            else 
                this._SrtConnectionStat();
        }, { immediate: true });

        // Enable disable / maxBandwidth
        this.on('srtEnableMaxBW', res => {
            if (!res) { this.srtMaxBw_div.style.display = "none" }
            else {this.srtMaxBw_div.style.display = "block" }
        }, { immediate: true });

        //----------------------SrtStats Modification-----------------------------//
    }

    _SrtConnectionStat(status) {
        if (status == "disconnected") {
            this._draggable.style["background-color"] = "#a1151a";
        } else {
            this._draggable.style["background-color"] = "#1E293B";
        }
    }

}