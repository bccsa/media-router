module.exports = {
    html: () => {
        return `
        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!------------------------------ General Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">General Settings</div>
        </div>

        <div class="w-full mb-4 flex ">

            <!--    Whep server port     --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_port}" class="form-label inline-block mb-2 mr-2">Whep Server Port:</label>
                <input type="number" min="1" oninput="validity.valid||(value='')" id="@{_port}" 
                    title="Opus FEC packet loss percentage (preset value)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{port}"
                >
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!------------------------------ Opus Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Opus Settings</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable OPUS Forward Error Correction      --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_showFec}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{opusFec}"/>  
                <label for="@{_showFec}" class="" title="Enable opus Forward Error Correction">Enable opus Forward Error Correction</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div class="w-full mb-4 flex ">
            <!-- FEC PacketLoss --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_opusFecPacketLoss}" class="form-label inline-block mb-2 mr-2">FEC packet loss:</label>
                <input type="number" min="0" max="100" oninput="validity.valid||(value='')" id="@{_opusFecPacketLoss}" 
                    title="Opus FEC packet loss percentage (preset value)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{opusFecPacketLoss}"
                >
            </div>

            <!-- complexity  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_opusComplexity}" class="form-label inline-block mb-2 mr-2">Complexity level:</label>
                <input type="number" min="0" max="10" oninput="validity.valid||(value='')" id="@{_opusComplexity}" 
                    title="Opus complexity level (0 - 10) where 0 is the lowest quality, and 10 is the highest quality." step="1" class="srtOpusInput-pos-number-input"
                    value="@{opusComplexity}"
                >
            </div>

            <!-- Bitrate -->
            <div class="w-1/3 flex flex-col">
                <label for="@{_opusBitrate}" class="form-label inline-block mb-2">Bitrate:</label>
                <select id="@{_opusBitrate}" title="Opus encoding target bitrate in kbps" value="@{opusBitrate}" 
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

        <div class="w-full mb-1 flex ">

            <!-- Opus Frame size -->
            <div class="w-1/3 flex mr-4 flex-col">
                <label for="@{_opusFrameSize}" class="form-label inline-block mb-2">Opus Frame Size:</label>
                <select id="@{_opusFrameSize}" title="Opus frame size (Can decrease to improve latency)" value="@{opusFrameSize}" 
                class="paAudioBase-select" type="text">
                    <option value="2.5">2.5</option>
                    <option value="5">5</option>
                    <option value="10">10</option>
                    <option value="20">20</option>
                    <option value="40">40</option>
                    <option value="60">60</option>
                </select>
            </div>

            <div class="w-1/3 mb-2 mr-4 flex">
                
            </div>

            <div class="w-1/3 mb-2 flex">
                
            </div>

        </div>
        `;
    },
};

const disabledSettings = `
        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!------------------------------ RED Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Red Settings</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable RED       --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_rtpRed}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{rtpRed}"/>  
                <label for="@{_rtpRed}" class="" title="Enable RED (Redundant Encoding Data) for RTP">Enable RED (Redundant Encoding Data) for RTP</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>`;
