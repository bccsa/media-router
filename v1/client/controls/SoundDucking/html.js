module.exports = {
    html: () => {
        return `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- ----------------------------------------------------------    Gate Settings    ---------------------------------------------------------- -->

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Audio Ducking (Live Updates)</div>
        </div>

        <!-- side_chain  -->
            <div class="w-full mb-2">
                <label for="@{_side_chain}" class="form-label inline-block">Side Chain:</label>
                <select id="@{_side_chain}" class="paAudioBase-select" type="text" title="PulseAudio source" value="@{side_chain}"></select>
        </div>

        <!--    Channel Map      -->
        <div class="w-full mb-1 mr-4">
            <label for="@{_channelMap}" class="mb-2">Channel map: </label>
            <input id="@{_channelMap}" class="paAudioBase-text-area" type="text" maxlength="60"
            placeholder="Channel map (e.g. 1,2)" title="Enter channel map as a comma-separated list of channel numbers" value="@{channelMap}" />
        </div>

        <!--    threshold     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_threshold}" class="mt-5 w-1/6">Threshold:</label>
        
            <input id="@{_threshold}" class="paAudioBase-slider" type="range"
                title="Audio level % where the ducker should kick in" name="threshold" step="1" min="0" max="100" value="@{threshold}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_threshold}" step="1" min="0" max="100" value="@{threshold}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    ducking_level     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_ducking_level}" class="mt-5 w-1/6">Ducking Level:</label>
        
            <input id="@{_ducking_level}" class="paAudioBase-slider" type="range"
                title="Audio level % that the audio should be ducked to" step="1" min="0" max="100" value="@{ducking_level}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_ducking_level}" step="1" min="0" max="100" value="@{ducking_level}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    attack     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_attack}" class="mt-5 w-1/6">Attack:</label>
        
            <input id="@{_attack}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio need to above the threshold, before levels is ducked" step="1" min="0" max="2000" value="@{attack}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_attack}" step="1" min="0" max="2000" value="@{attack}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    hold     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_hold}" class="mt-5 w-1/6">Hold:</label>
        
            <input id="@{_hold}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio need to below the threshold, before levels is restored" step="1" min="0" max="2000" value="@{hold}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_hold}" step="1" min="0" max="2000" value="@{hold}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        <!--    release     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_release}" class="mt-5 w-1/6">Release Time:</label>
        
            <input id="@{_release}" class="paAudioBase-slider" type="range"
                title="Time (ms) that the audio will take to restore to normal levels" step="1" min="0" max="2000" value="@{release}">

            <div class="max-w-[60px] truncate text-clip">
                <input type="number" for="@{_release}" step="1" min="0" max="2000" value="@{release}" class="w-[60px] truncate text-clip">
            </div>

        </div>

        `;
    },
};
