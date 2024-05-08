class SoundProcessor extends _paAudioSourceBase {
    constructor() {
        super();
        // EQ settings
        this.eq = false;            // Enable eq
        this.band0 = 0;             // Band 0 gain
        this.band1 = 0;             // Band 1 gain
        this.band2 = 0;             // Band 2 gain
        this.band3 = 0;             // Band 3 gain
        this.band4 = 0;             // Band 4 gain
        this.band5 = 0;             // Band 5 gain
        this.band6 = 0;             // Band 6 gain
        this.band7 = 0;             // Band 7 gain
        this.band8 = 0;             // Band 8 gain
        this.band9 = 0;             // Band 9 gain

        this.i_band0 = 0;             // Band 0 gain Internal
        this.i_band1 = 0;             // Band 1 gain Internal
        this.i_band2 = 0;             // Band 2 gain Internal
        this.i_band3 = 0;             // Band 3 gain Internal
        this.i_band4 = 0;             // Band 4 gain Internal
        this.i_band5 = 0;             // Band 5 gain Internal
        this.i_band6 = 0;             // Band 6 gain Internal
        this.i_band7 = 0;             // Band 7 gain Internal
        this.i_band8 = 0;             // Band 8 gain Internal
        this.i_band9 = 0;             // Band 9 gain Internal

        this._freqMap = [29, 59, 119, 237, 474, 947, 1889, 3770, 7523, 15011];

        //Delay Settings
        this.delay = false          // Enable Delay
        this.delayVal = 0;          // Delay Value
    }

    get html() {
        let bands = "";

        for (let i = 0; i < 10; i++) {
            let freq = this._freqMap[i];

            if (freq > 1000) { freq = Math.floor((freq / 1000) * 10) / 10 + "k" }

            bands += `
            <!-- Band${i} -->
            <div class=" h-full mb-2 flex">
                <!--    SLIDER     -->
                <div class="w-full mb-2 flex flex-col items-center">
                
                    <div class="text-clip">
                        <label for="@{_band${i}_slider}" class="text-clip">@{band${i}}</label>
                    </div>
                
                    <div class="mb-6 mt-9 flex flex-col items-center ">
                        <input id="@{_band${i}_slider}" class="EQ-slider" type="range" list="@{_band${i}_tickMarks}"
                            title="${freq}Hz Gain (-24db - 12 db)" name="band${i}" step="0.01" min="-1" max="1" value="@{i_band${i}}">
                    
                        <datalist id="@{_band${i}_tickMarks}">
                            <option value="-1"></option>
                            <option value="0"></option>
                            <option value="1"></option>
                        </datalist>
                    </div>

                    <div class="text-clip mt-5 rotate-[90deg]">
                        <label for="@{_band${i}_slider}" class="text-clip">${freq}</label>
                    </div>

                </div>
            </div>

            `
        }

        return super.html.replace('%additionalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">EQ Settings (Live Updates)</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable EQ     --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_showEq}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{eq}"/>  
                <label for="@{_showEq}" class="" title="Enable EQ">Enable EQ</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div class="w-full mb-1 flex grid grid-cols-10 gap-2">
            ${bands}
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Delay Settings</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable Delay     --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_showDelay}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{delay}"/>  
                <label for="@{_showDelay}" class="" title="Enable EQ">Enable Delay</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <!--    Delay     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <!-- Delay --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_delay}" class="form-label inline-block mb-2 mr-2">Delay (ms):</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_delay}" 
                    title="Audio Delay (ms)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{delayVal}"
                >
            </div>

            <div class="w-1/3 mr-4 flex flex-col"></div>

            <div class="w-1/3 flex flex-col"></div>

        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 
        `);
    }

    Init() {
        super.Init();
        this.setHeaderColor('#cc8d72');

        //----------------------Add event listeners for the bands-----------------------------//
        for (let i = 0; i < 10; i++) {
            this.on(`i_band${i}`, val => {
                let c = 0;
                if (val < 0) {c = val * 24} else { c = val * 12};
                this[`band${i}`] = Math.round(c * 10) / 10;
            })
        }

        //----------------------Add event listeners for the bands-----------------------------//

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SoundProcessor.md');
        //----------------------Help Modal-----------------------------//
    }
}