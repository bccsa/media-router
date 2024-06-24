class HlsPlayer extends _uiClasses(_paAudioSourceBase, SrtBase) {
    constructor() {
        super();
        this.hlsUrl = "";
        this.videoQuality = "";
        this.videoQualities = ['auto'];
        this.videoDelay = 0;
        this.audioDelay = 0;
        this.audioStreams = [];
        this._checkBoxes = [];
        this.defaultLanguage = "";
        this.sinkspaModuleID = [];
        this.enableSrt = false;
        this.runningSrt = false;
    }

    get html() {
        return super.html.replace('%additionalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- ----------------------------------------------------------    Input    ---------------------------------------------------------- -->

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Input Settings</div>
        </div>

        <!-- Hls url  -->
            <div class="w-full mb-2">
                <label for="@{_hlsUrl}" class="form-label inline-block">Hls Url:</label>
                <input id="@{_hlsUrl}" class="paAudioBase-select" type="text" title="Hls (m3u8) Url" placeholder="http://your.address.m3u8?some=params" value="@{hlsUrl}"></input>
        </div>

        <!-- Default Language  -->
        <div class="w-full mb-2">
            <label for="@{_defaultLanguage}" class="form-label inline-block">Default Language:</label>
            <select id="@{_defaultLanguage}" class="paAudioBase-select" type="text" title="Default Audio Language" value="@{defaultLanguage}">
               
            </select>
        </div>

        <!-- connection Speed -->
        <div class="w-1/3 mr-4 flex flex-col">
            <label for="@{_videoQuality}" class="form-label inline-block mb-2 mr-2">Video Quality:</label>
            <select id="@{_videoQuality}" class="paAudioBase-select" type="text" title="Video Quality" value="@{videoQuality}">
               
            </select>
        </div>

        <!-- audio sinks -->
        <div class="mr-4 flex flex-col">
            <label for="@{_audioStreams}" class="form-label inline-block mb-2 mr-2">Audio Streams:</label>
            <div id="@{_audioStreams}" class="w-full flex flex-wrap mr-2 mb-2 justify-start">

            </div>
        </div>

        <!-- ----------------------------------------------------------    Srt Settings    ---------------------------------------------------------- -->

        <div class="w-full mb-1 flex ">

            <!--    Enable SRT      --> 
            <div class="w-2/3 mr-2 mb-2 flex">
                <input id="@{_enableSrt}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{enableSrt}"/>  
                <label for="@{_enableSrt}" class="" title="Output video over SRT">Output video over SRT</label> 
            </div>

            <div class="w-1/3 mb-2 ml-2 flex">
                
            </div>

        </div>

        <div id=@{_srtDiv}>
            ${this.SrtBaseHtml()}
        </div>

        <!-- ----------------------------------------------------------    Delay Settings    ---------------------------------------------------------- -->

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Delay Settings</div>
        </div>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top italic text-sm">NB! Need to restart module for settings to take effect</div>
        </div>

        <div class="w-full mb-2 flex flex-row items-center">
        
            <!-- Video Delay --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_videoDelay}" class="form-label inline-block mb-2 mr-2">Video Delay (ms):</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_videoDelay}" 
                    title="Video Delay (ms)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{videoDelay}"
                >
            </div>

            <!-- Audio Delay -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_audioDelay}" class="form-label inline-block mb-2 mr-2">Audio Delay (ms):</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_audioDelay}" 
                    title="Audio Delay (ms)" step="1" class="srtOpusInput-pos-number-input"
                    value="@{audioDelay}"
                >
            </div>

            <div class="w-1/3 flex flex-col"></div>

        </div>
        `).replace("<!--  %SrtStatsHtml%  -->", this.SrtStatsHtml());
    }

    Init() {
        super.Init();
        // init SRT Spesific
        this._SrtInit();
        this.setHeaderColor('#cc8d72');

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/HlsPlayer.md');
        //----------------------Help Modal-----------------------------//

        //----------------------Load Audio streams-----------------------------//
        this.on('audioStreams', audioStreams => {
            this.createCB(audioStreams);
        }, { immediate: true });

        this.on('defaultLanguage', () => {
            this.createCB(this.audioStreams);
        });

        //----------------------Load Audio streams-----------------------------//

        //----------------------Load Video streams-----------------------------//
        
        this.on('videoQualities', videoQualities => {
            // clear dp
            while (this._videoQuality.options.length > 0) {                
                this._videoQuality.remove(0);
            } 

            this.videoQualities.forEach(v => {
                var opt = document.createElement('option');
                opt.value = v;
                opt.innerHTML = v;
                this._videoQuality.add(opt);
            })

            this.videoQuality = this.videoQualities[0];

        }, { immediate: true });

        //----------------------Load Video streams-----------------------------//

        //----------------------Srt Settings-----------------------------//
        this.on('enableSrt', e => {
            if (e) {
                this._srtDiv.style.display = "block";
            } else {
                this._srtDiv.style.display = "none";
            }
        }, { immediate: true });

        this.on('runningSrt', e => {
            if (!e) {
                this._btnSrtStats.style.display = "none";
                this._draggable.style["background-color"] = "#1E293B";
            } else {
                this._btnSrtStats.style.display = "block";
            }
        }, { immediate: true });
        //----------------------Srt Settings-----------------------------//
    }

    /**
     * Create check boxes 
     */
    createCB (audioStreams) {
        // --- Create dropdown --- //
        // clear dp
        while (this._defaultLanguage.options.length > 0) {                
            this._defaultLanguage.remove(0);
        } 

        this.audioStreams.forEach(s => {
            var opt = document.createElement('option');
            opt.value = s.language;
            opt.innerHTML = s.comment;
            this._defaultLanguage.add(opt);
        })

        this._defaultLanguage.value = this.defaultLanguage;

        // --- Create check boxes --- //
        // clear old elements
        while (this._checkBoxes.length > 0) {
            let c = this._checkBoxes.pop();
            c.Set({remove: true});
        }
        
        // recreate elemnts
        audioStreams.forEach((s, i) => {
            if (s.language != this.defaultLanguage) {
                this.once([s.language], (lang) => {
                    this._checkBoxes.push(lang);
                    lang.on('value', val => {
                        this.audioStreams[lang.index].enabled = val;
                        this.NotifyProperty('audioStreams');
                    })
                })

                this.SetData({
                    [s.language]: {
                        controlType: "checkBox",
                        label: s.comment,
                        color: "#cc8d72",
                        parentElement: "_audioStreams",
                        hideData: true,
                        value: s.enabled,
                        index: i
                    }
                });
            }
        })
    }

}