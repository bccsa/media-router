/**
 * This class should only be used as a super class for Audio devices.
 * Additional HTML content should be added through super.html.replace('%additionalHtml%','Your additional HTML');
 * Also run super.Init() in the overridden Init() function.
 */
class _paAudioBase extends ui {
    constructor() {
        super();
        this._styles.push('_paAudioBase.css');
        this.mute = false;
        this.description = "";
        this.volume = 100;
        this.channels = 1;
        this.sampleRate = 44100;
        this.bitDepth = 16;
        this.maxVolume = 150;
        this.soloGroup = "";
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayName = "New " + this.controlType;
        this.displayOrder = 0;
        this.left = 50;
        this.top = 50;
        this.width = 326.4;
        this.height = 93.6;
        this.showInTopBar = false;
        this.formatHideRW = false;   // true = Disable Read Write audio format controls. This can be used by implementing classes to enable / disable the audio format controls.
        this.formatHideRO = true;  // true = Disable Read Only audio format controls. This can be used by implementing classes to enable / disable the audio format controls.
        this.vuData = [];           // VU meter data
        this.enableVU = false;      // true = enable VU meter
        // z-60 fixed hidden w-full h-full outline-none modal fade overflow-scroll
    }

    get html() {
        return `


             <!--    MODAL DEVICE    -->
            <div id="@{_modalDeviceDetails}" class="paAudioBase-modal modal fade select-none" tabindex="-1" aria-hidden="true">
                <div class="modal-dialog paAudioBase-modal-dialog">
                    <div class="paAudioBase-modal-content">
    
                    <div class="paAudioBase-modal-header">
                        <div class="mr-4 flex justify-start">
                            
                            <!--    DUPLICATE    -->
                            <button id="@{_btnDuplicate}" class="paAudioBase-btn-duplicate"
                            type="button" data-bs-dismiss="modal" title="Duplicate Audio Device"></button>

                            <!--    DELETE   -->
                            <button id="@{_btnDelete}" class="paAudioBase-btn-delete"
                            type="button" data-bs-dismiss="modal" title="Delete Audio Device"></button>

                        </div> 

                        <h5 id="@{_modalHeading}" class="paAudioBase-modal-heading"> @{displayName}</h5>

                        <button class="paAudioBase-modal-btn-close" type="button"
                        data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
    
                    <div class="paAudioBase-modal-body">

                        <!--    DISPLAY NAME      -->
                        <div class="w-full mb-1 mr-4">
                            <div class="mr-4 w-full">
                                <label for="@{_displayName}" class="mb-2">Display Name: </label>
                                <input id="@{_displayName}" class="paAudioBase-text-area" type="text" maxlength="30"
                                placeholder="Your display name" title="Device display name" value="@{displayName}"/>
                            </div>
                        </div>
            
                        <!--    DESCRIPTION TEXT AREA     -->
                        <div class="w-full mb-1 mr-4">
                            <label for="@{_description}" class="mb-2">Description:</label>
                                <textarea id="@{_description}" class="paAudioBase-text-area" rows="1" cols="3"
                                title="Device description" placeholder="Your description" value="@{description}"></textarea>
                        </div>

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
                                <input id="@{_showInTopBar_input}" class="mr-2 mt-1 h-4 w-4" type="checkbox"  checked="@{showInTopBar}"/>  
                                <label for="@{_showInTopBar_input}" class="" title="Show the volume control in the top bar">Show the volume meter in the top bar</label> 
                            </div>


                        </div>

                        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

                        <div class="w-full items-center justify-items-center justify-center">
                            <div class="text-center align-top font-semibold text-base">Client Controls Settings</div>
                        </div>
                        
                        <!--    VOLUME SLIDER     -->
                        <div class="w-full mb-2 flex flex-row items-center">

                            <label for="@{_volume_slider}" class="mt-5 w-1/6">Volume:</label>

                            <input id="@{_volume_slider}" class="paAudioBase-slider" type="range" list="@{_tickMarks}"  title="Audio volume (1 = unity gain)" 
                            name="volume" step="1" min="0" max="@{maxVolume}" value="@{volume}" >
                            
                            <datalist id="@{_tickMarks}">
                                <option value="0"></option> <option value="10"></option> <option value="20"></option> 
                                <option value="30"></option> <option value="40"></option> <option value="50"></option>
                                <option value="60"></option> <option value="70"></option> <option value="80"></option> 
                                <option value="90"></option> <option value="100"></option> <option value="110"></option>
                                <option value="120"></option> <option value="130"></option> <option value="140"></option> 
                                <option value="150"></option>
                            </datalist>
                            <div class="w-1/6">
                                <label for="@{_volume_slider}" id="@{_rangeBullet}" class="ml-2">@{volume}</label>
                                <label for="@{_volume_slider}" id="@{_rangeBullet}" class="ml-1">%</label>
                            </div>
                        </div>

                        
                        <div class="w-full mb-1 flex ">

                            <!--    SHOW VOLUME CONTROL CHECKBOX      --> 
                            <div class="w-1/2 mr-2 mb-2 flex">
                                <input id="@{_showVolumeControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{showVolumeControl}"/>  
                                <label for="@{_showVolumeControl}" class="" title="Indicates that the front end should show the volume control">Show client volume control</label> 
                            </div>

                            <!--    SHOW MUTE CONTROL CHECKBOX      --> 
                            <div class="w-1/2 mb-2 ml-2 flex">
                                <input id="@{_showMuteControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{showMuteControl}"/>  
                                <label for="@{_showMuteControl}" class="" title="Indicates that the front end should show the mute control">Show client mute control</label>  
                            </div>

                        </div>
                        
                        <!--    DISPLAY ORDER     -->
                        <div class="w-full mb-1 flex ">

                            <div class="w-1/4 mr-3">
                                <label for="@{_displayOrder}" class="mb-2">Display Order:</label>
                                <input id="@{_displayOrder}" class="paAudioBase-pos-number-input" type="number" min="0"
                                oninput="validity.valid||(value='')" title="Display order in the client WebApp."
                                name="displayOrder" step="1" value="@{displayOrder}">
                            </div>

                            <div class="w-1/4 mr-3"></div> <div class="w-1/4 mr-3"></div>  <div class="w-1/4"></div>

                        </div>

                        <!--    SOLO GROUP    -->
                        <div class="w-full pb-3 mr-4">
                            <label for="@{_soloGroup}" class="mb-2">Solo Group:</label>
                                <input id="@{_soloGroup}" class="paAudioBase-text-area" type="text" 
                                title="If not blank, mutes all AudioMixerInputs with the same soloGroup text.";
                                placeholder="Solo group name:" value="@{soloGroup}"/>
                        </div>

                        <!-- EXTENDS AUDIO DEVICE  --> 
                        %additionalHtml%
                    </div>

                    <div class="paAudioBase-modal-footer">
                        
                    </div>
                        
                </div>
            </div>
        </div>

        

        <!-- ${this.name} -->

        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_draggable}" class="paAudioBase-main-card absolute">
            <!--    TOP HEADING CONTAINER    -->
            <div id="@{_heading}"  class="paAudioBase-card-heading overflow-hidden">

                <!--    NAME     -->
                <div class="col-span-2">
                    <div id="@{_name}" class="font-medium text-lg" title="Audio Input Name">@{displayName}</div>
                </div>

            </div>

            <div class="paAudioBase-card-body">

                <div class="flex justify-between items-center">
                    
                    <!--    ACTIVE TOGGLE     -->
                    <div class="flex">
                        <label for="@{_btnActive}" class="paAudioBase-label">On</label>
                        <div class="form-check form-switch">
                            <input id="@{_btnActive}" class="paAudioBase-toggle" type="checkbox" role="switch" checked="@{mute}">
                            <label for="@{_btnActive}" class="paAudioBase-label">Mute</label>
                        </div>
                    </div>

                    <!--    SETTINGS BUTTON     -->
                    <button id="@{_btnSettings}" class="paAudioBase-btn-settings" type="button" 
                    title="Open Device Settings" data-bs-toggle="modal" data-bs-target="#@{_modalDeviceDetails}"></button>
                    
                </div>
                
                <!--    VOLUME INDICATOR      -->
                <div id="@{_volume_slit}" class="_paAudioBase_volume_slit" title="Audio Indicator"></div>

                
            </div>
        </div>

        <div id="@{_externalControls}">
            <!-- Place external controls (e.g. connector lines etc.) in this div -->
        </div>
        `;
    }

    Init() {
        //Set initial values

        let position = this._checkCollision(this.left, this.top, "down");
        this._draggable.style.left = position.newLeft + "px";
        this._draggable.style.top = position.newTop + "px";
        this.left = (position.newLeft);
        this.top = (position.newTop);
        this._draggable.style.offsetHeight = this.height;
        this._draggable.style.offsetWidth = this.width;
        this._showInTopBar(this.showInTopBar);
        this._setDeviceColor();

        //Event subscriptions
        this._maxVolume.addEventListener('change', (e) => {

            if (this.maxVolume <= this.volume) {
                this.volume = Number.parseFloat(this._volume_slider.value);
                this.NotifyProperty("volume");
            }
        });

        // this._volume_slider.addEventListener('change', (e) => {

        //     this.showSliderValue();

        // });

        this.on('showInTopBar', val => {
            // Add or remove VU meter in router top bar
            this._showInTopBar(val);
        });


        let a = this;
        // Delete Device
        this._btnDelete.addEventListener('click', (e) => {
            // Show message box
            this.emit('messageBox',
                {
                    buttons: ["Cancel", "Yes"],
                    title: `Delete ${a.displayName}?`,
                    text: 'Are you sure you want to delete the device?',
                    img: 'bg-delete_bl',
                    callback: function (data) {
                        if (data == 'Yes') {
                            a._notify({ remove: true });
                            a.SetData({ remove: true });
                        }
                    }
                }, 'top');
        });

        // Duplicate Device
        this._btnDuplicate.addEventListener('click', (e) => {

            // Get unique random name
            let type = this.controlType;
            function randomName() {
                return type + "_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this._parent[name]) {
                name = randomName();
            }

            // Create new audio device
            let dup = this.GetData();
            delete dup.name;
            delete dup.destinations;

            dup.displayName += "(copy)";
            let position = this._checkCollision((dup.left), (dup.top + 70), "down");
            dup.top = position.newTop;
            dup.left = position.newLeft;

            this._parent.SetData({ [name]: dup });

            // send newly created audio device's data to manager
            this._parent._notify({ [name]: dup });
        });

        // Add VU meter
        this.SetData({
            vu: {
                controlType: "VuMeter",
                hideData: true,
                parentElement: `_volume_slit`,
                orientation: "horizontal",
                borderRadius: "25px",
            }
        });

        // Handle property changes
        this.on('vu', vu => {
            this.on('vuData', level => {
                this.vu.level = level;
            });
        });

        //-------------- Dragging Device --------------------

        let isMoving = false;
        let newLeft, newTop;
        let offsetH = 0, offsetW = 0;

        // Mouse down on heading, start to move the Device position
        this._heading.addEventListener("mousedown", event => {

            newTop = event.clientY - a._heading.getBoundingClientRect().top;
            newLeft = event.clientX - a._heading.getBoundingClientRect().left;
            offsetH = newTop;
            offsetW = newLeft;

            this._draggable.style.zIndex = "100";
            isMoving = true;
        })


        // Mouse move on the container
        this._parent._controlsDiv.addEventListener("mousemove", event => {

            newTop = event.clientY - a._parent._controlsDiv.getBoundingClientRect().top;
            newLeft = event.clientX - a._parent._controlsDiv.getBoundingClientRect().left;
            newTop -= offsetH;
            newLeft -= offsetW;

            if (isMoving) {
                setDevicePosition();
            }
        });

        // Change Device position as the mouse is moving
        function setDevicePosition() {

            // check container bounds
            let dropZoneLeft = a._parent._controlsDiv.offsetLeft - 60;
            let dropZoneTop = a._parent._controlsDiv.offsetTop - 10;
            let dropZoneWidth = a._parent._controlsDiv.getBoundingClientRect().width - 304;
            let dropZoneHeight = a._parent._controlsDiv.getBoundingClientRect().height - 76;

            // verify and adapt newLeft and newTop positions
            if (newLeft < dropZoneLeft) { newLeft = dropZoneLeft }
            if (newLeft > dropZoneWidth) { newLeft = dropZoneWidth }
            if (newTop < dropZoneTop) { newTop = dropZoneTop }
            if (newTop > dropZoneHeight) { newTop = dropZoneHeight }

            // Check Collision so that no Device stack on each other
            let position = a._checkCollision(newLeft, newTop);

            a._draggable.style.left = (position.newLeft) + "px";
            a._draggable.style.top = (position.newTop) + "px";

            a.left = (position.newLeft);
            a.top = (position.newTop);

            // Emit event posChanged, so that the Lines are updated when Device is moved
            a.emit('posChanged', a.calcConnectors());
        }

        // Mouse up on document, stop to move the Device position
        document.addEventListener("mouseup", event => {
            a._draggable.style.zIndex = "10";
            if (isMoving) {

                let position;
                // Check if the Device is at the upper or lower bound and adjust accordingly
                if (a.top > (a._parent._controlsDiv.getBoundingClientRect().height - 90)) {
                    position = a._checkCollision(a.left, a.top, "up");
                }
                else {
                    position = a._checkCollision(a.left, a.top, "down");
                }

                a._draggable.style.left = position.newLeft + "px";
                a._draggable.style.top = position.newTop + "px";
                a.left = (position.newLeft);
                a.top = (position.newTop);

                this.NotifyProperty("left");
                this.NotifyProperty("top");

                a.emit('posChanged', a.calcConnectors());
            }

            isMoving = false;
        });



        this.on('left', (e) => {
            this._draggable.style.left = this.left + "px";
            this.emit('posChanged', this.calcConnectors());
        });

        this.on('top', (e) => {
            this._draggable.style.top = this.top + "px";
            this.emit('posChanged', this.calcConnectors());
        });

        //-------------------------------------------------------------------------

        // As we are using CSS transforms (in tailwind CSS), it is not possible to set an element fixed to the browser viewport.
        // A workaround is to move the modal element out of the elements styled by the transform.
        this._topLevelParent._controlsDiv.prepend(this._modalDeviceDetails);

        // Delete modal when this control is removed
        this.on('remove', () => {
            this._modalDeviceDetails.remove();
        });
    }

    /**
     * Calculate connector positions
     * @returns 
     */
    calcConnectors() {
        return {
            leftConnector: { top: (this.top + (this._draggable.clientHeight / 2) + 4), left: this.left + 5 },
            rightConnector: { top: (this.top + (this._draggable.clientHeight / 2) + 4), left: (this.left + (this._draggable.clientWidth) + 5) }
        };
    }

    // Set the different colors for the Devices
    _setDeviceColor() {

        if (this.controlType == "AudioInput") {
            this._heading.style.backgroundColor = "#012F74"; // cc6666  012F74
        }
        if (this.controlType == "SrtOpusInput") {
            this._heading.style.backgroundColor = "#0D6EFD"; // 1D1F4C 00067B C92C6D 0D6EFD
        }
        if (this.controlType == "AudioOutput") {
            this._heading.style.backgroundColor = "#007F6A"; // 602100 D98324 #A24936
        }
        if (this.controlType == "SrtOpusOutput") {
            this._heading.style.backgroundColor = "#00C3A3"; // 753B1C 9D3700 A33900 bb6528 #D36135
        }
    }

    /**
     * Create or remove a VU meter in the parent top bar
     * @param {*} show 
     */
    _showInTopBar(show) {

        let a = this;

        function _VuData(data) {
            a._parent[a.name + "_vu"].level = data;
        }

        if (show) {

            if (!this._parent[this.name + "_vu"]) {
                this._parent.on(this.name + "_vu", control => {
                    this.on('vuData', _VuData);
                })

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
                this.off('vuData', _VuData);
                this._parent[this.name + "_vu"].SetData({ remove: true });
            }
        }
    }

    // Check for collision with other Device elements
    _checkCollision(newLeft, newTop, direction = "") {
        let collision = true;

        let dropZoneLeft = this._parent._controlsDiv.offsetLeft - 60;
        let dropZoneTop = this._parent._controlsDiv.offsetTop - 10;
        let dropZoneWidth = this._parent._controlsDiv.offsetWidth + 50;
        let dropZoneHeight = this._parent._controlsDiv.offsetHeight - 40;

        while (collision) {
            collision = false;

            Object.values(this._parent._controls).forEach(control => {

                if (this._draggable != control._draggable) {

                    let childLeft = control.left;
                    let childTop = control.top;
                    let childWidth = control.width;
                    let childHeight = control.height;

                    let midX = newLeft + this.width / 2;
                    let midY = newTop + this.height / 2;
                    let childMidX = control.left + control.width / 2;
                    let childMidY = control.top + control.height / 2;

                    // Check Collision
                    if (newLeft < childLeft + childWidth && newLeft + this.width > childLeft &&
                        newTop < childTop + childHeight && newTop + this.height > childTop) {
                        collision = true;

                        if (direction == "") {
                            if (childMidX - 200 >= midX) {
                                direction = "left";
                            } else if (midX >= childMidX + 180) {
                                direction = "right";
                            } else if (childMidY > midY) {
                                direction = "up";
                            } else if (childMidY <= midY) {
                                direction = "down";
                            }
                        }

                        if (direction == "left") {
                            newLeft = childLeft - childWidth - 2;
                        } else if (direction == "right") {
                            newLeft = childLeft + childWidth + 2;
                        } else if (direction == "up") {
                            newTop = childTop - childHeight - 2;
                        } else if (direction == "down") {
                            newTop = childTop + childHeight + 2;
                        }

                        // Check border bounds and limit movement
                        newLeft = Math.max(dropZoneLeft, Math.min(newLeft, dropZoneLeft + dropZoneWidth - this.width));
                        newTop = Math.max(dropZoneTop, Math.min(newTop, dropZoneTop + dropZoneHeight - this.height));

                        if (newLeft === dropZoneLeft || newLeft === dropZoneLeft + dropZoneWidth - this.width ||
                            newTop === dropZoneTop || newTop === dropZoneTop + dropZoneHeight - this.height) {
                            collision = false;
                        }
                    }
                }
            });
        }

        return {
            newLeft,
            newTop
        }
    }
}