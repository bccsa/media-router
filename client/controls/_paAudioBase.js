/**
 * This class should only be used as a super class for Audio devices.
 * Additional HTML content should be added through super.html.replace('%additionalHtml%','Your additional HTML');
 * Also run super.Init() in the overridden Init() function.
 */
class _paAudioBase extends _routerChildControlBase {
    constructor() {
        super();
        // this._styles.push('_paAudioBase.css');
        this.mute = false;
        this.volume = 100;
        this.channels = 1;
        this.sampleRate = 44100;
        this.bitDepth = 16;
        this.maxVolume = 150;
        this.soloGroup = "";
        this.showVolumeControl = true;  // Show volume slider on local client
        this.showMuteControl = true;    // Show mute button on local client
        this.showInTopBar = false;
        this.formatHideRW = false;   // true = Disable Read Write audio format controls. This can be used by implementing classes to enable / disable the audio format controls.
        this.formatHideRO = true;  // true = Disable Read Only audio format controls. This can be used by implementing classes to enable / disable the audio format controls.
        this.vuData = [];           // VU meter data
        this.enableVU = true;      // true = enable VU meter
    }

    get html() {
        return super.html

            // Add card HTML
            .replace('%cardHtml%', `
        <div class="flex justify-between items-center">
            <!--    ACTIVE TOGGLE  -->
            <label class="relative inline-flex items-center mr-5 cursor-pointer">
                <span class="paAudioBase-label">Mute</span>
                <input id="@{_btnActive}" class="sr-only peer" type="checkbox" checked="@{mute}">
                <div
                    class="self-center w-9 h-4 bg-green-600 rounded-full peer peer-focus:ring-2 dark:bg-gray-700 peer-checked:after:-translate-x-[20px] peer-checked:after:border-white after:content-[''] after:absolute after:left-[64.35px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-red-500">
                </div>
                <span class="paAudioBase-label ml-2">On</span>
            </label>
        </div>
        
        <!--    VOLUME INDICATOR      -->
        <div id="@{_volume_slit}" class="_paAudioBase_volume_slit" title="Audio Indicator"></div>
        `)

            // Add modal HTML
            .replace('%modalHtml%', `
        <div class="w-full flex">

            <!--    CHANNELS      -->
            <div class="w-1/4 mr-3">
                <label for="@{_channels}" class="mb-2">Channels:</label>
                <div class="mb-3 w-full">
                    <select id="@{_channels}" class="paAudioBase-select" title="Audio channel number (default = 1)"
                        value="@{channels}" name="channel" type="text" hidden="@{formatHideRW}">
                        <option value="1">1</option>
                        <option value="2">2</option>
                    </select>
                    <label hidden="@{formatHideRO}">@{channels}</label>
                </div>
            </div>
        
            <!--    SAMPLE RATE    -->
            <div class="w-1/4 mr-3">
                <label for="@{_sampleRate}" class="mb-2">Sample Rate:</label>
                <div class="mb-3 w-full">
                    <select id="@{_sampleRate}" class="paAudioBase-select" title="Audio sample rate (default = 48000)"
                        value="@{sampleRate}" name="sampleRate" type="text" hidden="@{formatHideRW}">
                        <option value="44100">44100 Hz</option>
                        <option value="48000">48000 Hz</option>
                    </select>
                    <label hidden="@{formatHideRO}">@{sampleRate}</label>
                </div>
            </div>
        
            <!-- BIT DEPTH   -->
            <div class="w-1/4 mr-3">
                <label for="@{_bitDepth}" class="mb-2">Bit Depth:</label>
                <div class="mb-3 w-full">
                    <select id="@{_bitDepth}" class="paAudioBase-select" title="Audio bit depth (default = 16)"
                        value="@{bitDepth}" name="bitDepth" type="text" hidden="@{formatHideRW}">
                        <option value="16">16</option>
                        <option value="24">24</option>
                        <option value="32">32</option>
                    </select>
                    <label hidden="@{formatHideRO}">@{bitDepth}</label>
                </div>
            </div>
        
            <!--    MAX VOLUME    -->
            <div class="w-1/4">
                <label for="@{_maxVolume}" class="mb-2">Max Volume:</label>
                <div class="mb-3 w-full">
                    <input id="@{_maxVolume}" type="number" min="0" oninput="validity.valid||(value='')"
                        title="Maximum volume that the client WebApp can request" name="maxVolume" step="1"
                        class="paAudioBase-pos-decimal-input" value="@{maxVolume}">
                </div>
            </div>
        
        </div>
        
        <div class="w-full mb-1 flex ">
        
            <!--    SHOW CONTROL IN TOP BAR     -->
            <div class="w-full mr-2 mb-2 flex">
                <input id="@{_showInTopBar_input}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{showInTopBar}" />
                <label for="@{_showInTopBar_input}" class="" title="Show the volume control in the top bar">Show the volume
                    meter in the top bar</label>
            </div>
        
        
        </div>
        
        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div>
        
        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">Client Controls Settings</div>
        </div>
        
        <!--    VOLUME SLIDER     -->
        <div class="w-full mb-2 flex flex-row items-center">
        
            <label for="@{_volume_slider}" class="mt-5 w-1/6">Volume:</label>
        
            <input id="@{_volume_slider}" class="paAudioBase-slider" type="range" list="@{_tickMarks}"
                title="Audio volume (1 = unity gain)" name="volume" step="1" min="0" max="@{maxVolume}" value="@{volume}">
        
            <datalist id="@{_tickMarks}">
                <option value="0"></option>
                <option value="10"></option>
                <option value="20"></option>
                <option value="30"></option>
                <option value="40"></option>
                <option value="50"></option>
                <option value="60"></option>
                <option value="70"></option>
                <option value="80"></option>
                <option value="90"></option>
                <option value="100"></option>
                <option value="110"></option>
                <option value="120"></option>
                <option value="130"></option>
                <option value="140"></option>
                <option value="150"></option>
            </datalist>
            <div class="w-[3/24] max-w-[40px] truncate text-clip">
                <label for="@{_volume_slider}" class="max-w-[40px] truncate text-clip">@{volume}</label>
            </div>

            <div class="w-[1/24] ">
                <label for="@{_volume_slider}" class="ml-1">%</label>
            </div>

        </div>
        
        
        <div class="w-full mb-1 flex ">
            <!--    SHOW VOLUME CONTROL CHECKBOX      -->
            <div class="w-1/2 mr-2 mb-2 flex">
                <input id="@{_showVolumeControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{showVolumeControl}" />
                <label for="@{_showVolumeControl}" class=""
                    title="Indicates that the front end should show the volume control">Enable local client volume</label>
            </div>
        
            <!--    SHOW MUTE CONTROL CHECKBOX      -->
            <div class="w-1/2 mb-2 ml-2 flex">
                <input id="@{_showMuteControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{showMuteControl}" />
                <label for="@{_showMuteControl}" class=""
                    title="Indicates that the front end should show the mute control">Enable local client mute</label>
            </div>
        </div>
        
        <!--    SOLO GROUP    -->
        <div class="w-full pb-3 mr-4">
            <label for="@{_soloGroup}" class="mb-2">Solo Group:</label>
            <input id="@{_soloGroup}" class="paAudioBase-text-area" type="text"
                title="If not blank, mutes all AudioMixerInputs with the same soloGroup text." placeholder="Solo group name:"
                value="@{soloGroup}" />
        </div>
        
        <!-- EXTENDS AUDIO DEVICE  -->
        %additionalHtml%
        `);
    }

    Init() {
        super.Init();

        // Event subscriptions
        this.on('showInTopBar', val => {
            // Add or remove VU meter in router top bar
            this._showInTopBar(val);
        }, { immediate: true });

        this._maxVolume.addEventListener('change', (e) => {
            if (this.maxVolume <= this.volume) {
                this.volume = Number.parseFloat(this._volume_slider.value);
            }
        });

        // Handle property changes
        this.on('vu', vu => {
            this.on('vuData', level => {
                vu.level = level;
            });

            //----------------------Scale-----------------------------//
            this._parent.on('scale', scale => {

                vu.scale = scale;

            }, { immediate: true, caller: this });
            //----------------------Scale-----------------------------//

        });



        // Add VU meter
        this.SetData({
            vu: {
                controlType: "VuMeter",
                hideData: true,
                parentElement: `_volume_slit`,
                orientation: "horizontal",
                borderRadius: "25px",
                scale: this._parent.scale,
            }
        });



        this.on('remove', remove => {
            // Remove from parent control
            if (this._parent[this.name + "_vu"]) {
                this._parent[this.name + "_vu"].SetData({ remove: true });
            }
        });

    }


    /**
     * Create or remove a VU meter in the parent top bar
     * @param {*} show 
     */
    _showInTopBar(show) {
        if (show) {

            if (!this._parent[this.name + "_vu"]) {
                this._parent.on(this.name + "_vu", control => {
                    this.on('vuData', vuData => {
                        control.level = vuData;
                    }, { caller: control });
                });

                // Add VU meter to Router Top Bar
                this._parent.SetData({
                    [this.name + "_vu"]: {
                        controlType: "VuMeter",
                        hideData: true,
                        parentElement: `_topBarControls`,
                        orientation: "horizontal",
                        borderRadius: "25px",
                        background: `linear-gradient(
                            to right,
                            hsla(120, 100%, 25%, 0.200) 66.6666%,
                            rgba(255, 166, 0, 0.200) 66.6666% 85%,
                            rgba(255, 0, 0, 0.200) 85%)`,

                        width: "120px",
                        height: "20px",
                        marginLeft: "4px",
                        marginRight: "4px",
                        borderRadius: "25px",
                        boxShadow: "white",
                        transform: "rotate(180deg)",
                        title: this.displayName,
                    }
                });
            }
        } else {
            // Remove from parent control
            if (this._parent[this.name + "_vu"]) {
                this._parent[this.name + "_vu"].SetData({ remove: true });
            }
        }
    }
}