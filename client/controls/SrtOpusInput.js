class SrtOpusInput extends _audioInputDevice {
    constructor() {
        super();
        this.srtHost = 'srt.invalid';
        this.srtPort = 5000;
        this.srtMode = 'caller';
        this.srtPbKeyLen = 16;
        this.srtPassphrase = '';
        this.srtLatency = 200;
        this.srtMaxBw = 8000;
        this.srtStreamID = '';
    }

    get html() {
        return super.html.replace('%additionalHtml%', `

        <!-- Divider line  -->
        <div class="w-full mb-6 items-center justify-items-center justify-center"></div>
        <div class="w-[30rem] mb-4 flex -ml-4 -mr-16 -pr-16">
            <div class="w-4/12">
                <div class="mt-3 w-full h-[0.01rem] bg-[#75C4EB]"></div>
            </div>
            <div class="w-3/12 text-center align-top font-semibold text-base">SRT Settings</div>
            <div class="w-5/12">
                <div class="mt-3 w-full h-[0.01rem] bg-[#75C4EB]"></div>
            </div>
        </div>

        <!-- SRT host  -->
        <div class="w-full mb-2 mr-4">
            <label for="${this._uuid}_srtHost" class="form-label inline-block mb-2">SRT Host:</label>
                <textarea
                    class="audioDevice-text-area"
                    id="${this._uuid}_srtHost"
                    title="SRT host name / ip address"
                    rows="1" cols="3"
                    placeholder="Your srt Host"
                >${this.srtHost}</textarea>
        </div>

        <div class="w-full mb-2 flex ">
            <!-- SRT port  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="${this._uuid}_srtPort" class="form-label inline-block mb-2 mr-2">SRT Port:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="${this._uuid}_srtPort" 
                    title="SRT port" name="SRT port" step="1" class="srtOpusInput-pos-number-input"
                    value="${this.srtPort}"
                >
            </div>

            <!-- SRT Latency  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="${this._uuid}_srtLatency" class="form-label inline-block mb-2 mr-2">SRT Latency:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="${this._uuid}_srtLatency" 
                    title="SRT latency in milliseconds" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="${this.srtLatency}"
                >
            </div>

            <!-- SRT Max Bandwidth  --> 
            <div class="w-1/3 flex flex-col">
                <label for="${this._uuid}_srtMaxBw" class="form-label inline-block mb-2 mr-2">SRT Max Bw:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="${this._uuid}_srtMaxBw" 
                    title="SRT Max Bandwidth in bytes per second" name="SRT MaxBw" step="1" class="srtOpusInput-pos-number-input"
                    value="${this.srtMaxBw}"
                >
            </div>

        </div>

        <div class="w-full mb-2 flex ">

            <!-- SRT Mode  -->    
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="${this._uuid}_srtMode" class="form-label inline-block mb-2">SRT Mode:</label>
                <select id="${this._uuid}_srtMode" title="SRT mode (caller, listener, rendezvous)" value="${this.srtMode}" 
                name="SRT Mode" class="audioDevice-select" type="text">
                    <option value="caller">Caller</option>
                    <option value="listener">Listener</option>
                    <option value="rendezvous">Rendezvous</option>
                </select>
            </div>

            <!-- SRT PbKeyLen  -->    
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="${this._uuid}_srtPbKeyLen" class="form-label inline-block mb-2">SRT Pb Key Len:</label>
                <select id="${this._uuid}_srtPbKeyLen" title="SRT encryption key length (16, 32)" value="${this.srtPbKeyLen}" 
                name="SRT PbKeyLen" class="audioDevice-select" type="text">
                    <option value="16">16</option>
                    <option value="32">32</option>
                </select>
            </div>

            <div class="w-1/3"></div>

        </div>

        <!-- SRT Passphrase  -->
        <div class="w-full mb-2 mr-4">
            <label for="${this._uuid}_srtPassphrase" class="form-label inline-block mb-2">SRT Passphrase:</label>
                <textarea
                    class="audioDevice-text-area"
                    id="${this._uuid}_srtPassphrase"
                    title="SRT encryption passphrase"
                    rows="1" cols="3"
                    placeholder="Your srt Passphrase"
                >${this.srtPassphrase}</textarea>
        </div>

        <!-- SRT StreamID  -->
        <div class="w-full mb-2 mr-4">
            <label for="${this._uuid}_srtStreamID" class="form-label inline-block mb-2">SRT Stream ID:</label>
                <textarea
                    class="audioDevice-text-area"
                    id="${this._uuid}_srtStreamID"
                    title="SRT Stream ID"
                    rows="1" cols="3"
                    placeholder="Your srt StreamID"
                >${this.srtStreamID}</textarea>
        </div>


        `);
    }

 
    Init() {
        super.Init();
        this._srtHost = document.getElementById(`${this._uuid}_srtHost`);
        this._srtPort = document.getElementById(`${this._uuid}_srtPort`);
        this._srtMode = document.getElementById(`${this._uuid}_srtMode`);
        this._srtPbKeyLen = document.getElementById(`${this._uuid}_srtPbKeyLen`);
        this._srtPassphrase = document.getElementById(`${this._uuid}_srtPassphrase`);
        this._srtLatency = document.getElementById(`${this._uuid}_srtLatency`);
        this._srtMaxBw = document.getElementById(`${this._uuid}_srtMaxBw`);
        this._srtStreamID = document.getElementById(`${this._uuid}_srtStreamID`);

        // Set initial values 
        this._srtMode.value = this.srtMode;
        this._srtPbKeyLen.value = this.srtPbKeyLen;

        //Event subscriptions
        this._srtHost.addEventListener('change', (e) => {
            this.srtHost = this._srtHost.value;
        });

        this._srtPort.addEventListener('change', (e) => {
            this.srtPort = this._srtPort.value;
        });

        this._srtMode.addEventListener('change', (e) => {
            this.srtMode = this._srtMode.value;
        });

        this._srtPbKeyLen.addEventListener('change', (e) => {
            this.srtPbKeyLen = this._srtPbKeyLen.value;
        });

        this._srtPassphrase.addEventListener('change', (e) => {
            this.srtPassphrase = this._srtPassphrase.value;
        });

        this._srtLatency.addEventListener('change', (e) => {
            this.srtLatency = this._srtLatency.value;
        });

        this._srtMaxBw.addEventListener('change', (e) => {
            this.srtMaxBw = this._srtMaxBw.value;
        });

        this._srtStreamID.addEventListener('change', (e) => {
            this.srtStreamID = this._srtStreamID.value;
        });

        // Handle property changes

        this.on('srtHost', srtHost => {
            this._srtHost.value = srtHost;
        });

        this.on('srtPort', srtPort => {
            this._srtPort.value = srtPort;
        });

        this.on('srtMode', srtMode => {
            this._srtMode.value = srtMode.toLowerCase();
        });

        this.on('srtPbKeyLen', srtPbKeyLen => {
            this._srtPbKeyLen.value = srtPbKeyLen;
        });

        this.on('srtPassphrase', srtPassphrase => {
            this._srtPassphrase.value = srtPassphrase;
        });

        this.on('srtLatency', srtLatency => {
            this._srtLatency.value = srtLatency;
        });

        this.on('srtMaxBw', srtMaxBw => {
            this._srtMaxBw.value = srtMaxBw;
        });

        this.on('srtStreamID', srtStreamID => {
            this._srtStreamID.value = srtStreamID;
        });
    }
}