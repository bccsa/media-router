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

        // Audio Compressor
        this.compressor = false;
        this.comp_knee = 2.8;
        this.comp_ratio = 1;
        this.comp_threshold = 0.001;
        this.comp_attack = 20;
        this.comp_release = 250;
        this.comp_makeup = 1;
        this.comp_threshold_val = Math.round(this.comp_threshold * 1000) / 1000;
        // comp Graph
        this.comp_path0 = "M 0 100 L 80 20 L 100 10";
        this.comp_path1 = "M 0 20 L 100 20";

        // Gate / Expander 
        this.gate = false;
        this.gate_knee = 2.8;
        this.gate_ratio = 1;
        this.gate_threshold = 0.001;
        this.gate_attack = 20;
        this.gate_release = 250;
        this.gate_makeup = 1;
        this.gate_threshold_val = Math.round(this.comp_threshold * 1000) / 1000;
        // gate Graph
        this.gate_path0 = "M 0 100 L 80 20 L 100 10";
        this.gate_path1 = "M 0 20 L 100 20";
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

        <!-- ----------------------------------------------------------   EQ Settings   ---------------------------------------------------------- -->

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

        <!-- ----------------------------------------------------------    Gate Settings    ---------------------------------------------------------- -->

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Audio Gate (Live Updates)</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable Gate     --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_showGate}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{gate}"/>  
                <label for="@{_showGate}" class="" title="Enable EQ">Enable Gate</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div class="m-10 mr-24 ml-24 bg-gray-100">
            <div class="">
                <svg viewBox="0 0 100 100" class="">
                <!-- X-axis -->
                <line x1="0" y1="100" x2="100" y2="100" class="stroke-current text-gray-700" />
                <!-- Y-axis -->
                <line x1="0" y1="0" x2="0" y2="100" class="stroke-current text-gray-700" />
                <!-- Data line (example) -->
                <path id="@{_gate_path0}" d="${this.gate_path0}" fill="none" stroke="black" stroke-width="1" />
                <path id="@{_gate_path1}" d="${this.gate_path1}" fill="none" stroke="black" stroke-width="1" stroke-dasharray="3" />
                </svg>
            </div>
        </div>

        <!--    knee     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_gate_knee}" class="mt-5 w-1/6">Knee:</label>
        
            <input id="@{_gate_knee}" class="paAudioBase-slider" type="range"
                title="Curve the sharp knee around the threshold to enter gain reduction more softly" name="gate_knee" step="0.01" min="1" max="8" value="@{gate_knee}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_gate_knee}" class="max-w-[40px] truncate text-clip">@{gate_knee}</label>
            </div>

        </div>

        <!--    ratio     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_gate_ratio}" class="mt-5 w-1/6">Ratio:</label>
        
            <input id="@{_gate_ratio}" class="paAudioBase-slider" type="range"
                title="Set a ratio about which the signal is reduced. 1:2 means that if the level rises 4dB above the threshold, it will be only 2dB above after the reduction." name="gate_ratio" step="0.01" min="1" max="20" value="@{gate_ratio}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_gate_ratio}" class="max-w-[40px] truncate text-clip">@{gate_ratio}</label>
            </div>

        </div>

        <!--    threshold     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_gate_threshold}" class="mt-5 w-1/6">Threshold:</label>
        
            <input id="@{_gate_threshold}" class="paAudioBase-slider" type="range"
                title="If a signal rises above this level it will affect the gain reduction" name="gate_threshold" step="0.000976563" min="0.000976563" max="1" value="@{gate_threshold}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_gate_threshold}" class="max-w-[40px] truncate text-clip">@{gate_threshold_val}</label>
            </div>

        </div>

        <!--    makeup     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_gate_makeup}" class="mt-5 w-1/6">Makeup:</label>
        
            <input id="@{_gate_makeup}" class="paAudioBase-slider" type="range"
                title="Amplify your signal after processing" name="gate_makeup" step="0.01" min="1" max="64" value="@{gate_makeup}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_gate_makeup}" class="max-w-[40px] truncate text-clip">@{gate_makeup}</label>
            </div>

        </div>

        <!--    attack     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_gate_attack}" class="mt-5 w-1/6">Attack:</label>
        
            <input id="@{_gate_attack}" class="paAudioBase-slider" type="range"
                title="Amount of milliseconds the signal has to rise above the threshold before gain reduction starts" name="gate_attack" step="1" min="1" max="2000" value="@{gate_attack}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_gate_attack}" class="max-w-[40px] truncate text-clip">@{gate_attack}</label>
            </div>

        </div>

        <!--    release     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_gate_release}" class="mt-5 w-1/6">Release:</label>
        
            <input id="@{_gate_release}" class="paAudioBase-slider" type="range"
                title="Amount of milliseconds the signal has to fall below the threshold before the reduction is decreased again" name="gate_release" step="1" min="1" max="2000" value="@{gate_release}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_gate_release}" class="max-w-[40px] truncate text-clip">@{gate_release}</label>
            </div>

        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- ----------------------------------------------------------    Compressor Settings    ---------------------------------------------------------- -->

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Audio Compressor (Live Updates)</div>
        </div>

        <div class="w-full mb-1 flex ">

            <!--    Enable Compressor     --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_showCompressor}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{compressor}"/>  
                <label for="@{_showCompressor}" class="" title="Enable EQ">Enable Compressor</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div class="m-10 mr-24 ml-24 bg-gray-100">
            <div class="">
                <svg viewBox="0 0 100 100" class="">
                <!-- X-axis -->
                <line x1="0" y1="100" x2="100" y2="100" class="stroke-current text-gray-700" />
                <!-- Y-axis -->
                <line x1="0" y1="0" x2="0" y2="100" class="stroke-current text-gray-700" />
                <!-- Data line (example) -->
                <path id="@{_comp_path0}" d="${this.comp_path0}" fill="none" stroke="black" stroke-width="1" />
                <path id="@{_comp_path1}" d="${this.comp_path1}" fill="none" stroke="black" stroke-width="1" stroke-dasharray="3" />
                </svg>
            </div>
        </div>

        <!--    knee     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_comp_knee}" class="mt-5 w-1/6">Knee:</label>
        
            <input id="@{_comp_knee}" class="paAudioBase-slider" type="range"
                title="Curve the sharp knee around the threshold to enter gain reduction more softly" name="comp_knee" step="0.01" min="1" max="8" value="@{comp_knee}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_comp_knee}" class="max-w-[40px] truncate text-clip">@{comp_knee}</label>
            </div>

        </div>

        <!--    ratio     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_comp_ratio}" class="mt-5 w-1/6">Ratio:</label>
        
            <input id="@{_comp_ratio}" class="paAudioBase-slider" type="range"
                title="Set a ratio about which the signal is reduced. 1:2 means that if the level rises 4dB above the threshold, it will be only 2dB above after the reduction." name="comp_ratio" step="0.01" min="1" max="20" value="@{comp_ratio}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_comp_ratio}" class="max-w-[40px] truncate text-clip">@{comp_ratio}</label>
            </div>

        </div>

        <!--    threshold     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_comp_threshold}" class="mt-5 w-1/6">Threshold:</label>
        
            <input id="@{_comp_threshold}" class="paAudioBase-slider" type="range"
                title="If a signal rises above this level it will affect the gain reduction" name="comp_threshold" step="0.000976563" min="0.000976563" max="1" value="@{comp_threshold}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_comp_threshold}" class="max-w-[40px] truncate text-clip">@{comp_threshold_val}</label>
            </div>

        </div>

        <!--    makeup     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_comp_makeup}" class="mt-5 w-1/6">Makeup:</label>
        
            <input id="@{_comp_makeup}" class="paAudioBase-slider" type="range"
                title="Amplify your signal after processing" name="comp_makeup" step="0.01" min="1" max="64" value="@{comp_makeup}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_comp_makeup}" class="max-w-[40px] truncate text-clip">@{comp_makeup}</label>
            </div>

        </div>

        <!--    attack     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_comp_attack}" class="mt-5 w-1/6">Attack:</label>
        
            <input id="@{_comp_attack}" class="paAudioBase-slider" type="range"
                title="Amount of milliseconds the signal has to rise above the threshold before gain reduction starts" name="comp_attack" step="1" min="1" max="2000" value="@{comp_attack}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_comp_attack}" class="max-w-[40px] truncate text-clip">@{comp_attack}</label>
            </div>

        </div>

        <!--    release     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_comp_release}" class="mt-5 w-1/6">Release:</label>
        
            <input id="@{_comp_release}" class="paAudioBase-slider" type="range"
                title="Amount of milliseconds the signal has to fall below the threshold before the reduction is decreased again" name="comp_release" step="1" min="1" max="2000" value="@{comp_release}">

            <div class="max-w-[60px] truncate text-clip">
                <label for="@{_comp_release}" class="max-w-[40px] truncate text-clip">@{comp_release}</label>
            </div>

        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- ----------------------------------------------------------    Delay Settings    ---------------------------------------------------------- -->

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

        //----------------------Add event listeners for compressor-----------------------------//
        this.on("comp_threshold", val => { this.comp_threshold_val = Math.round(val * 1000) / 1000 });

        // calc comp graph on init
        this.comp_calcGraph()
        this.on("comp_knee", () => {this.comp_calcGraph()});
        this.on("comp_ratio", () => {this.comp_calcGraph()});
        this.on("comp_threshold", () => {this.comp_calcGraph()});
        this.on("comp_makeup", () => {this.comp_calcGraph()});

        //----------------------Add event listeners for compressor-----------------------------//
        
        //----------------------Add event listeners for gate-----------------------------//
        this.on("gate_threshold", val => { this.gate_threshold_val = Math.round(val * 1000) / 1000 });

        // calc comp graph on init
        this.gate_calcGraph()
        this.on("gate_knee", () => {this.gate_calcGraph()});
        this.on("gate_ratio", () => {this.gate_calcGraph()});
        this.on("gate_threshold", () => {this.gate_calcGraph()});
        this.on("gate_makeup", () => {this.gate_calcGraph()});

        //----------------------Add event listeners for gate-----------------------------//

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SoundProcessor.md');
        //----------------------Help Modal-----------------------------//
    }

    /**
     * Calculate path on graph for gate
     */
    gate_calcGraph() {
        let _threshhold_x = this.gate_threshold * 100; 
        let _threshhold_y = 100 - (this.gate_threshold * 100); 

        let ang = Math.atan(1 / this.gate_ratio);
        let side = 25 * (this.gate_knee - 1) / 8 // side length (max = 25% of graph)
        let knee_x1 = _threshhold_x - (Math.sin(ang) * side);
        let knee_y1 = Math.cos(ang) * side + _threshhold_y;
        let knee_x2 = _threshhold_x + side;
        let knee_y2 = _threshhold_y - side;

        let makeup = (this.gate_makeup -1) / 63 * 100;

        let s = ((100 - knee_y1) - (100 - _threshhold_y))/(knee_x1 - _threshhold_x);
        let m = -s * _threshhold_x + (100 - _threshhold_y + makeup);
        let _ratio_x = -m / s;

        this._gate_path0.setAttribute("d", `M ${_ratio_x} 100 L ${knee_x1} ${knee_y1 - makeup} S ${_threshhold_x} ${_threshhold_y - makeup} ${knee_x2} ${knee_y2 - makeup} L 100 ${0 - makeup}`);
        this._gate_path1.setAttribute("d", `M 0 ${_threshhold_y - makeup} L 100 ${_threshhold_y - makeup}`);
    }

    /**
     * Calculate path on graph for Comp
     */
    comp_calcGraph() {
        let _threshhold_x = 100 - (this.comp_threshold * 100); 
        let _threshhold_y = this.comp_threshold * 100; 
        let _ratio_y = _threshhold_y - (_threshhold_y / this.comp_ratio);

        let ang = Math.atan(1/this.comp_ratio);
        let side = 25 * (this.comp_knee - 1) / 8 // side lenght
        let knee_x1 = _threshhold_x - side;
        let knee_y1 = _threshhold_y + side;
        let knee_x2 = Math.cos(ang) * side + _threshhold_x;
        let knee_y2 = 100 - (Math.sin(ang) * side + (100 - _threshhold_y));

        let makeup = (this.comp_makeup -1) / 63 * 100;

        this._comp_path0.setAttribute("d", `M 0 ${100 - makeup} L ${knee_x1} ${knee_y1 - makeup} S ${_threshhold_x} ${_threshhold_y - makeup} ${knee_x2} ${knee_y2 - makeup} L 100 ${_ratio_y  - makeup}`);
        this._comp_path1.setAttribute("d", `M 0 ${_threshhold_y - makeup} L 100 ${_threshhold_y - makeup}`);
    }
}