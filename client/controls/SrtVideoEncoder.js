class SrtVideoEncoder extends _uiClasses(_paAudioSinkBase, SrtBase) {
    constructor() {
        super();
        // capture
        this.devices = [];
        this.video_device = "/dev/video0";
        this.video_device_descr = "Video0 (disconnected)";
        this.capture_format = "raw";
        this.deinterlace = false;
        // encoder
        this.encoder = "v4l2h264enc";   // options (software: openh264enc, hardware: v4l2h264enc)
        this.video_bitrate = "2M";
        this.video_gop = 30;            // amount of frame interval before a new full frame is sent       
        this.video_width = 1280;
        this.video_height = 720;
        this.video_framerate = 30;
        this.audio_bitrate = 196; 
    }

    get html() {
        return super.html.replace('%additionalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!------------------------------ Capture Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Capture Settings</div>
        </div>

        <div class="w-full mb-4 flex ">
            <!-- Video Device -->
            <div class="w-full flex flex-col">
                <label for="@{_video_device}" class="form-label inline-block mb-2">Video Device:</label>
                <select id="@{_video_device}" title="Video device" value="@{video_device}" 
                class="paAudioBase-select" type="text"></select>
            </div>
        </div>

        <div class="w-full mb-4 flex ">
            <!-- Capture Format -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_capture_format}" class="form-label inline-block mb-2">Capture Format:</label>
                <select id="@{_capture_format}" title="Video input format" value="@{capture_format}" 
                class="paAudioBase-select" type="text">
                    <option value="raw">raw</option>
                    <option value="mjpeg">mjpeg</option>
                </select>
            </div>

            <!-- Deinterlace -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_deinterlace}" class=""
                    title="Enable or disable deinterlacing">Enable Deinterlacing</label>
                <input id="@{_deinterlace}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{deinterlace}" />
            </div>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!------------------------------ Encoder Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Encoder Settings</div>
        </div>

        <div class="w-full mb-4 flex ">
            <!-- Audio Bitrate -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_audio_bitrate}" class="form-label inline-block mb-2">Audio Bitrate:</label>
                <select id="@{_audio_bitrate}" title="AAC encoding target bitrate in kbps" value="@{audio_bitrate}" 
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

            <!-- Video Bitrate -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_video_bitrate}" class="form-label inline-block mb-2">Video Bitrate:</label>
                    <input id="@{_video_bitrate}" class="paAudioBase-text-area" type="text"
                    title="Video Encoding bitrate" placeholder="2M" value="@{video_bitrate}"/>
            </div>

            <!-- Encoder -->
            <div class="w-1/3 flex flex-col">
                <label for="@{_encoder}" class="form-label inline-block mb-2">Encoder:</label>
                <select id="@{_encoder}" title="options (software: openh264enc, hardware: v4l2h264enc)" value="@{encoder}" 
                class="paAudioBase-select" type="text">
                    <option value="v4l2h264enc">Hardware Encoder</option>
                    <option value="openh264enc">Software Encoder</option>
                </select>
            </div>

        </div>

        <div class="w-full mb-4 flex ">
            <!-- Video GOP -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_video_gop}" class="form-label inline-block mb-2 mr-2">Video GOP:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_video_gop}" 
                    title="Amount of frame interval before a new full frame is sent" name="Video GOP" step="1" class="srtOpusInput-pos-number-input"
                    value="@{video_gop}"
                >
            </div>

            <!-- Place holder -->
            <div class="w-1/3 mr-4 flex flex-col">
            </div>

            <!-- Place holder -->
            <div class="w-1/3 mr-4 flex flex-col">
            </div>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!------------------------------ Output Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Output Settings</div>
        </div>

        <div class="w-full mb-4 flex ">
            <!-- Video Width  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_video_width}" class="form-label inline-block mb-2 mr-2">Video Width:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_video_width}" 
                    title="Video Width" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="@{video_width}"
                >
            </div>

            <!-- Video Height  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_video_height}" class="form-label inline-block mb-2 mr-2">Video Height:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_video_height}" 
                    title="Video Height" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="@{video_height}"
                >
            </div>

            <!-- Video Framerate  --> 
            <div class="w-1/3 flex flex-col">
                <label for="@{_video_framerate}" class="form-label inline-block mb-2 mr-2">Video Framerate:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_video_framerate}" 
                    title="Video Framerate" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="@{video_framerate}"
                >
            </div>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        ${this.SrtBaseHtml()}
        `)
        .replace("<!--  %SrtStatsHtml%  -->", this.SrtStatsHtml());
    }


    Init() {
        super.Init();
        this.setHeaderColor('#00C3A3');

        // init SRT Spesific
        this._SrtInit();

        // update list of video devices 
        this.on('devices', devices => {
            // add new options
            devices.forEach(device => {
                let _s = [...this._video_device.options].find(t => t.value == device.device);
                if (!_s) {
                    let o = document.createElement('option');
                    o.value = device.device;
                    o.text = device.name;
                    this._video_device.options.add(o);
                } else if (_s.value == this.video_device)  {
                    _s.text = device.name;
                }
            });

            // remove invalid options
            [...this._video_device.options].forEach(option => {
                let _s = devices.find(t => t.device == option.value)
                if (!_s && option.value != this.video_device) {       // Remove removed input's && input is not the master input (this is done to avoid input's changing when the device is not connected)
                    this._video_device.options.remove(option.index);
                } else if (!_s) {                               // If master is removed, change name to disconnected
                    option.text = this.video_device_descr + " (disconnected)";
                }
            });

            // Set index / device
            let o = [...this._video_device.options].find(t => t.value == this.video_device);
            if (o) {
                this._video_device.selectedIndex = o.index;
            } else {
                // add video_device to the list, if it is not in the list 
                let o = document.createElement('option');
                o.value = this.video_device;
                o.text = this.video_device_descr + " (disconnected)";
                this._video_device.options.add(o);
            }
        })

        // update saved video device desctiption
        this.on('video_device', () => this.video_device_descr = this.devices.find(t => t.device == this.video_device).name);

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SrtVideoEncoder.md'); // Load aditional MD
        //----------------------Help Modal-----------------------------//
    }
}