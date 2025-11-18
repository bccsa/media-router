module.exports = {
    html: () => {
        return `
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
                <select id="@{_video_bitrate}" title="Video Encoding bitrate" value="@{video_bitrate}" 
                class="paAudioBase-select" type="text">
                    <option value="24M">24M</option>
                    <option value="20M">20M</option>
                    <option value="16M">16M</option>
                    <option value="12M">12M</option>
                    <option value="10M">10M</option>
                    <option value="8M">8M</option>
                    <option value="6M">6M</option>
                    <option value="5M">5M</option>
                    <option value="4M">4M</option>
                    <option value="3M">3M</option>
                    <option value="2M">2M</option>
                    <option value="1M">1M</option>
                    <option value="768k">768k</option>
                    <option value="512k">512k</option>
                    <option value="256k">256k</option>
                    <option value="128k">128k</option>
                </select>
            </div>

            <!-- Encoder -->
            <div class="w-1/3 flex flex-col">
                <label for="@{_encoder}" class="form-label inline-block mb-2">Encoder:</label>
                <select id="@{_encoder}" title="options (software: x264enc, hardware: v4l2h264enc)" value="@{encoder}" 
                class="paAudioBase-select" type="text">
                    <option value="v4l2h264enc">Hardware Encoder</option>
                    <option value="x264enc">Software Encoder</option>
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

            <!-- x264 Speed Preset -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_x264_speed_preset}" class="form-label inline-block mb-2">x264 Speed Preset:</label>
                <select id="@{_x264_speed_preset}" title="x264enc speed/quality tradeoff preset" value="@{x264_speed_preset}" 
                class="paAudioBase-select" type="text">
                    <option value="ultrafast">ultrafast</option>
                    <option value="superfast">superfast</option>
                    <option value="veryfast">veryfast</option>
                    <option value="faster">faster</option>
                    <option value="fast">fast</option>
                    <option value="medium">medium</option>
                    <option value="slow">slow</option>
                    <option value="slower">slower</option>
                    <option value="veryslow">veryslow</option>
                    <option value="placebo">placebo</option>
                </select>
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
            <!-- Video Quality  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_video_quality}" class="form-label inline-block mb-2 mr-2">Video Quality:</label>
                <select id="@{_video_quality}" title="Video Quality (16X9)" value="@{video_quality}" 
                class="paAudioBase-select" type="number">
                    <option value="2160">2160p (4k)</option>
                    <option value="1800">1800p (QHD+)</option>
                    <option value="1440">1440p (WQHD)</option>
                    <option value="1080">1080p (FHD)</option>
                    <option value="720">720p (HD)</option>
                    <option value="540">540p (qHD)</option>
                    <option value="480">480p (FWVGA)</option>
                    <option value="360">360p (nHD)</option>
                </select>
            </div>

            <!-- Video Framerate  --> 
            <div class="w-1/3 flex flex-col">
                <label for="@{_video_framerate}" class="form-label inline-block mb-2 mr-2">Video Framerate:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_video_framerate}" 
                    title="Video Framerate" name="SRT Latency" step="1" class="srtOpusInput-pos-number-input"
                    value="@{video_framerate}"
                >
            </div>

            <!-- Place holder -->
            <div class="w-1/3 mr-4 flex flex-col">
            </div>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 
        `;
    },
};
