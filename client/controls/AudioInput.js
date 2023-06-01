class AudioInput extends _audioInputDevice {
    constructor() {
        super();
        this.deviceType = "AudioInput";
        this.device = "New Device";
        this.bufferSize = 64; // 64, 128, 256, 512, 1024, 2048, 4096
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        
        
        <div class="w-full mb-1 flex ">

            <!-- Device  -->
            <div class="w-1/2 mr-3">
                <label for="@{_device}" class="form-label inline-block mb-2">Device:</label>
                <select id="@{_device}" class="audioDevice-select" type="text" 
                title="ALSA Device name - see aplay -L (Default = default)"
                value="${this.device}" >
                    <option value="default">default</option>
                    <option value="Device 2">Device 2</option>
                    <option value="Device 3">Device 3</option>
                    <option value="Device 4">Device 4</option>
                    <option value="Device 5">Device 5</option>
                    <option value="Device 6">Device 6</option>
                    <option value="Device 7">Device 7</option>
                </select>
            </div>

            <!-- Buffer Size  -->    
            <div class="w-1/2">
                <label for="@{_bufferSize}" class="form-label inline-block mb-2">Buffer Size:</label>
                <select id="@{_bufferSize}" title="ALSA buffer size in bytes (Default = 64)" value="${this.bufferSize}" 
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


        </div>
        `);
    }

 
    Init() {
        super.Init();
        // this._device = document.getElementById(`${this._uuid}_device`);
        // this._bufferSize = document.getElementById(`${this._uuid}_bufferSize`);

        // Set initial values
        this._bufferSize.value = this.bufferSize; 

        //Event subscriptions
        this._device.addEventListener('change', (e) => {
            this.device = this._device.value;
            this.NotifyProperty("device");
        });

        this._bufferSize.addEventListener('change', (e) => {
            this.bufferSize = Number.parseInt(this._bufferSize.value);
            this.NotifyProperty("bufferSize");
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