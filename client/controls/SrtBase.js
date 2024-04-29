class SrtBase {
    constructor() {
        this.srtHost = 'srt.invalid';
        this.srtPort = 1234;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = 10;
        this.srtMaxBw = 8000;   // not implemented in server yet
        this.srtStreamID = '';
        this.caller_count = 0;      // amount of callers connected to module
    }

    SrtBaseHtml() {
        return `

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

            <!-- Place holder  --> 
            <div class="w-1/3 mr-4 flex flex-col"></div>

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
        }, { immediate: true })

        this.on("caller_count", (_c) => { 
            if (_c == 0)
                this._SrtConnectionStat("disconnected");
        });

        //----------------------SrtStats Modification-----------------------------//
    }

    _SrtConnectionStat(status) {
        if (status == "disconnected" && this.srtMode == "caller") {
            this._draggable.style["background-color"] = "#a1151a";
        } else {
            this._draggable.style["background-color"] = "#1E293B";
        }
    }

}