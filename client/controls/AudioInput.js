class AudioInput extends _audioInputDevice {
    constructor() {
        super();
        this.deviceType = "AudioInput";
        this.device = "New Device";
        this.bufferSize = 64; // 64, 128, 256, 512, 1024, 2048, 4096
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <!-- Device  -->
        <div class="w-full mb-2 mr-4">
            <label for="${this._uuid}_device" class="form-label inline-block mb-2">Device:</label>
                <textarea
                    class="audioDevice-text-area"
                    id="${this._uuid}_device"
                    title="ALSA Device name - see aplay -L (Default = default)"
                    rows="1" cols="3"
                    placeholder="Your device"
                >${this.device}</textarea>
        </div>
        
        <div class="w-full mb-1 flex ">

            <!-- Buffer Size  -->    
            <div class="w-1/4 mr-3">
                <label for="${this._uuid}_bufferSize" class="form-label inline-block mb-2">Buffer Size:</label>
                <select id="${this._uuid}_bufferSize" title="ALSA buffer size in bytes (Default = 64)" value="${this.bufferSize}" 
                name="bufferSize" class="audioDevice-select" type="text">
                    <option value="64">64</option>
                    <option value="128">128</option>
                    <option value="256">256</option>
                    <option value="512">512</option>
                    <option value="1024">1024</option>
                    <option value="2048">2048</option>
                    <option value="4096">4096</option>
                </select>
            </div>

            <div class="w-1/4 mr-3"></div>
            <div class="w-1/4 mr-3"></div>
            <div class="w-1/4"></div>

        </div>
        `);
    }

 
    Init() {
        super.Init();
        this._device = document.getElementById(`${this._uuid}_device`);
        this._bufferSize = document.getElementById(`${this._uuid}_bufferSize`);

        // Set initial values
        this._bufferSize.value = this.bufferSize; 

        //Event subscriptions
        this._device.addEventListener('change', (e) => {
            this.device = this._device.value;
        });

        this._bufferSize.addEventListener('change', (e) => {
            this.bufferSize = this._bufferSize.value;
        });

        // Handle property changes

        this.on('device', device => {
            this._device.value = device;
        });

        this.on('bufferSize', bufferSize => {
            this._bufferSize.value = bufferSize;
        });
    }
}