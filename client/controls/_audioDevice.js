/**
 * This class should only be used as a super class for Audio devices.
 * Additional HTML content should be added through super.html.replace('%additionalHtml%','Your additional HTML');
 * Also run super.Init() in the overridden Init() function.
 */
class _audioDevice extends ui {
    constructor() {
        super();
        this._styles.push('_audioDevice.css');
        this.level = 0;
        this.mute = true;
        this.description = "";
        this.volume = 1;
        this.channels = 1;
        this.sampleRate = 48000;
        this.bitDepth = 16;
        this.maxVolume = 1.5;
        this.soloGroup = "";
        this.showVolumeControl = true;
        this.showMuteControl = true;
        this.displayName = "New " + this.controlType;
        this.displayOrder = 0;
        this.peak = 0;
        this.left = 50;
        this.top = 50;

        this.width = 328.8;
        this.height = 68;
        // z-60 fixed hidden w-full h-full outline-none modal fade overflow-scroll
    }

    get html() {
        return `

        <div id="@{_modalContainer}" class="hidden" >
             <!--    MODAL DEVICE    -->
                <div id="@{_modalDeviceDetails}" class="audioDevice-modal modal fade" tabindex="-1" aria-hidden="true">
                    <div class="modal-dialog modal-lg audioDevice-modal-dialog">
                        <div class="audioDevice-modal-content">
        
                        <div class="audioDevice-modal-header">
                            <div class="mr-4 flex justify-start">
                                
                                <!--    DUPLICATE    -->
                                <button id="@{_btnDuplicate}" class="audioDevice-btn-duplicate"
                                type="button" data-bs-dismiss="modal" title="Duplicate Audio Device"></button>

                                <!--    DELETE   -->
                                <button id="@{_btnDelete}" class="audioDevice-btn-delete"
                                type="button" data-bs-dismiss="modal" title="Delete Audio Device"></button>

                            </div> 

                            <h5 id="@{_modalHeading}" class="audioDevice-modal-heading"> ${this.displayName}</h5>

                            <button class="audioDevice-modal-btn-close" type="button"
                            data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
        
                        <div class="audioDevice-modal-body">

                            <!--    DISPLAY NAME      -->
                            <div class="w-full mb-1 mr-4">
                                <div class="mr-4 w-full">
                                    <label for="@{_displayName}" class="mb-2">Display Name: </label>
                                    <input id="@{_displayName}" class="audioDevice-text-area" type="text" maxlength="30"
                                    placeholder="Your display name" title="Device display name" value="${this.displayName}"/>
                                </div>
                            </div>
                
                            <!--    DESCRIPTION TEXT AREA     -->
                            <div class="w-full mb-1 mr-4">
                                <label for="@{_description}" class="mb-2">Description:</label>
                                    <textarea id="@{_description}" class="audioDevice-text-area" rows="1" cols="3"
                                    title="Device description" placeholder="Your description" >${this.description}</textarea>
                            </div>

                            <!--    SOLO GROUP    -->
                            <div class="w-full mr-4">
                                <label for="@{_soloGroup}" class="mb-2">Solo Group:</label>
                                    <input id="@{_soloGroup}" class="audioDevice-text-area" type="text" 
                                    title="If not blank, mutes all AudioMixerInputs with the same soloGroup text.";
                                    placeholder="Solo group name:" value="${this.soloGroup}"/>
                            </div>

                            <!--    VOLUME SLIDER     -->
                            <div class="w-full mb-2 flex flex-row items-end">

                                <label for="@{_volume}" class="mt-5 w-1/6">Volume:</label>

                                <input id="@{_volume_slider}" class="audioDevice-slider" type="range" list="@{_tickMarks}"  title="Audio volume (1 = unity gain)" 
                                name="volume" step="0.01" min="0" max="${this.maxVolume}" value="${this.volume}" >
                                
                                <datalist id="@{_tickMarks}">
                                    <option value="0.00"></option> <option value="0.10"></option> <option value="0.20"></option> 
                                    <option value="0.30"></option> <option value="0.40"></option> <option value="0.50"></option>
                                    <option value="0.60"></option> <option value="0.70"></option> <option value="0.80"></option> 
                                    <option value="0.90"></option> <option value="1.0"0></option> <option value="1.10"></option>
                                    <option value="1.20"></option> <option value="1.30"></option> <option value="1.40"></option> 
                                    <option value="1.50"></option>
                                </datalist>

                                <label for="@{_volume}" id="@{_rangeBullet}" class="ml-2 w-1/6">${this.volume * 100} %</label>
                                
                            </div>

                            <div class="w-full mb-1 flex ">

                                <!--    CHANNELS      -->
                                <div class="w-1/4 mr-3">
                                    <label for="@{_channels}" class="mb-2">Channels:</label>
                                        <div class="mb-3 w-full">
                                            <select id="@{_channels}" class="audioDevice-select" title="Audio channel number (default = 1)"
                                            value="${this.channels}" name="channel" type="text">
                                                <option value="1">1</option>
                                                <option value="2">2</option>
                                            </select>
                                        </div>
                                </div>
                                
                                <!--    SAMPLE RATE    -->
                                <div class="w-1/4 mr-3">
                                    <label for="@{_sampleRate}" class="mb-2">Sample Rate:</label>
                                    <select id="@{_sampleRate}" class="audioDevice-select" title="Audio sample rate (default = 48000)"
                                    value="${this.sampleRate}" name="sampleRate" type="text">
                                        <option value="44100">44100 Hz</option>
                                        <option value="48000">48000 Hz</option>
                                    </select>
                                </div>

                                <!-- BIT DEPTH   -->    
                                <div class="w-1/4 mr-3">
                                    <label for="@{_bitDepth}" class="mb-2">Bit Depth:</label>
                                    <select id="@{_bitDepth}" class="audioDevice-select" title="Audio bit depth (default = 16)"
                                    value="${this.bitDepth}" name="bitDepth" type="text">
                                        <option value="16">16</option>
                                        <option value="24">24</option>
                                        <option value="32">32</option>
                                    </select>
                                </div>

                                <!--    MAX VOLUME    --> 
                                <div class="w-1/4">
                                    <label for="@{_maxVolume}" class="mb-2">Max Volume:</label>
                                    <input id="@{_maxVolume}" type="number" min="0" oninput="validity.valid||(value='')" 
                                    title="Maximum volume that the client WebApp can request" name="maxVolume" step="0.1"
                                    class="audioDevice-pos-decimal-input" value="${this.maxVolume}">
                                </div>

                            </div>

                            <div class="w-full mb-1 flex ">

                                <!--    SHOW VOLUME CONTROL CHECKBOX      --> 
                                <div class="w-1/2 mr-2 mb-2 flex">
                                    <input id="@{_showVolumeControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked  value="${this.showVolumeControl}"/>  
                                    <label for="@{_showVolumeControl}" class="" title="Indicates that the front end should show the volume control">Show client volume control</label> 
                                </div>

                                <!--    SHOW MUTE CONTROL CHECKBOX      --> 
                                <div class="w-1/2 mb-2 flex">
                                    <input id="@{_showMuteControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked value="${this.showMuteControl}"/>  
                                    <label for="@{_showMuteControl}" class="" title="Indicates that the front end should show the mute control">Show client mute control</label>  
                                </div>

                            </div>
                            
                            <!--    DISPLAY ORDER     -->
                            <div class="w-full mb-1 flex ">

                                <div class="w-1/4 mr-3">
                                    <label for="@{_displayOrder}" class="mb-2">Display Order:</label>
                                </div>
                    
                                <div class="w-1/4 mr-3">
                                    <input id="@{_displayOrder}" class="audioDevice-pos-number-input" type="number" min="0"
                                    oninput="validity.valid||(value='')" title="Display order in the client WebApp."
                                    name="maxVolume" step="1" value="${this.displayOrder}">
                                </div>

                                <div class="w-1/4 mr-3"></div> <div class="w-1/4"></div>

                            </div>

                            <!-- EXTENDS AUDIO DEVICE  --> 
                            %additionalHtml%
                        </div>

                        <div class="audioDevice-modal-footer">
                            
                        </div>
                            
                    </div>
                </div>
            </div>
        </div>

        

        <!-- ${this.name} -->

        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_draggable}" class="audioDevice-main-card absolute">
            <!--    TOP HEADING CONTAINER    -->
            <div class="audioDevice-heading">

                <!--    NAME AND VOLUME INDICATOR      -->
                <div class="mb-1 col-span-2">
                    <div id="@{_name}" class="font-medium text-lg" title="Audio Input Name">${this.displayName}</div>
                    <div id="@{_volume_slit}" class="audioDevice_volume_slit" title="Audio Indicator"></div>
                </div>

                <div class="">

                    <div class="flex justify-end"
                    <!--    SETTINGS BUTTON     -->
                    <button id="@{_btnSettings}" class="audioDevice-btn-settings" type="button" 
                    title="Open Device Settings" data-bs-toggle="modal" data-bs-target="#@{_modalDeviceDetails}"></button>
                    </div>

                    <!--    MUTE TOGGLE     -->
                    <div class="mr-4 flex">
                        <label for="@{_btnMute}" class="audioDevice-label">Off</label>
                        <div class="form-check form-switch">
                            <input id="@{_btnMute}" class="audioDevice-toggle" type="checkbox" role="switch" title="Switch Mute on or off">
                            <label for="@{_btnMute}" class="audioDevice-label">On</label>
                        </div>
                    </div>

                </div>
            </div>
        </div>

        <div id="@{_externalControls}">
            <!-- Place external controls (e.g. connector lines etc.) in this div -->
        </div>
        `;
    }

    Init() {
        //Set initial values
        // this._setMute();

        this._btnMute.checked = this.mute;
        this._channels.value = this.channels;
        this._sampleRate.value = this.sampleRate;
        this._bitDepth.value = this.bitDepth;
        this._showVolumeControl.checked = this.showVolumeControl;
        this._showMuteControl.checked = this.showMuteControl;
        let position = this._checkCollision(this.left, this.top, "down");
        this._draggable.style.left = position.newLeft + "px";
        this._draggable.style.top = position.newTop + "px";
        this.left = (position.newLeft);
        this.top = (position.newTop);

        this.NotifyProperty("left");
        this.NotifyProperty("top");


        this._draggable.style.offsetHeight = this.height;
        this._draggable.style.offsetWidth = this.width;

        //Event subscriptions
        this._btnMute.addEventListener('click', (e) => {
            this.mute = !this.mute;
            // this._setMute();
            this.NotifyProperty("mute");
        });

        this._displayName.addEventListener('change', (e) => {
            this.displayName = this._displayName.value;
            this._name.innerText = this.displayName;
            this._modalHeading.innerText = this.displayName;
            this.NotifyProperty("displayName");
        })

        this._description.addEventListener('change', (e) => {
            this.description = this._description.value;
            this.NotifyProperty("description");
        });

        this._volume_slider.addEventListener('input', (e) => {
            this.volume = Number.parseFloat(this._volume_slider.value);
            this.showSliderValue();
            this.NotifyProperty("volume");
        });

        this._channels.addEventListener('change', (e) => {
            this.channels = Number.parseInt(this._channels.value);
            this.NotifyProperty("channels");
        });

        this._sampleRate.addEventListener('change', (e) => {
            this.sampleRate = Number.parseInt(this._sampleRate.value);
            this.NotifyProperty("sampleRate");
        });

        this._bitDepth.addEventListener('change', (e) => {
            this.bitDepth = Number.parseInt(this._bitDepth.value);
            this.NotifyProperty("bitDepth");
        });

        this._maxVolume.addEventListener('change', (e) => {
            this.maxVolume = Number.parseFloat(this._maxVolume.value);
            this._volume_slider.max = this.maxVolume;
            this.showSliderValue();
            this.NotifyProperty("maxVolume");

            if (this.maxVolume <= this.volume) {
                this.volume = Number.parseFloat(this._volume_slider.value);
                this.showSliderValue();
                this.NotifyProperty("volume");
            }
        });

        this._soloGroup.addEventListener('change', (e) => {
            this.soloGroup = this._soloGroup.value;
            this.NotifyProperty("soloGroup");
        });

        this._showVolumeControl.addEventListener('change', (e) => {
            this.showVolumeControl = !this.showVolumeControl;
            this.NotifyProperty("showVolumeControl");
        });

        this._showMuteControl.addEventListener('change', (e) => {
            this.showMuteControl = !this.showMuteControl;
            this.NotifyProperty("showMuteControl");
        });

        this._displayOrder.addEventListener('change', (e) => {
            this.displayOrder = Number.parseInt(this._displayOrder.value);
            this.NotifyProperty("displayOrder");
        });

        let a = this;
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
            }
        });

        // Handle property changes
        this.on('level', level => {
            if (this.vu) {
                this.vu.level = level;
            }
        });

        this.on('mute', mute => {
            this._btnMute.checked = mute;
        });

        this.on('displayName', displayName => {
            this._displayName.value = displayName;
            this._name.innerHTML = displayName;
        })

        this.on('description', description => {
            this._description.value = description;
        });

        this.on('volume', () => {
            this._setVolume();
        });

        this.on('channels', channels => {
            this._channels.value = channels;
        });

        this.on('sampleRate', sampleRate => {
            this._sampleRate.value = sampleRate;
        });

        this.on('bitDepth', bitDepth => {
            this._bitDepth.value = bitDepth;
        });

        this.on('maxVolume', maxVolume => {
            this._maxVolume.value = maxVolume;
            this._volume_slider.max = this.maxVolume;
        });

        this.on('soloGroup', soloGroup => {
            this._soloGroup.value = soloGroup;
        });

        this.on('showVolumeControl', showVolumeControl => {
            this._showVolumeControl.checked = showVolumeControl;
        });

        this.on('showMuteControl', showMuteControl => {
            this._showMuteControl.checked = showMuteControl;
        });

        this.on('displayOrder', displayOrder => {
            this._displayOrder.value = displayOrder;
        });

        // Drag drop

        // let isMoving = false;

        // function drag_start(event) {
        //     isMoving = true;
        //     var style = window.getComputedStyle(event.target, null);
        //     event.dataTransfer.setData("text/plain",
        //         (parseInt(style.getPropertyValue("left"), 10) - event.clientX) + ',' + (parseInt(style.getPropertyValue("top"), 10) - event.clientY));
        // }
        // function drag_over(event) {
        //     event.preventDefault();
        //     return false;
        // }

        // this._draggable.addEventListener('dragstart', drag_start, false);
        // this._parent._controlsDiv.addEventListener('dragover', drag_over, false);


        // this._parent._controlsDiv.addEventListener('drop', event => {

        //     // Check for collision with other child elements
        //     var offset = event.dataTransfer.getData("text/plain").split(',');
        //     let newLeft = event.clientX + parseInt(offset[0], 10);
        //     let newTop = event.clientY + parseInt(offset[1], 10);

        //     // console.log(newTop + " " + newLeft );

        //     let position = this._checkCollision(newLeft, newTop);


        //     if (isMoving) {
        //         var offset = event.dataTransfer.getData("text/plain").split(',');
        //         a._draggable.style.left = position.newLeft + 'px';
        //         a._draggable.style.top = position.newTop + 'px';

        //         a.left = position.newLeft;
        //         a.top = position.newTop;

        //         a.NotifyProperty("left");
        //         a.NotifyProperty("top");

        //         event.preventDefault();
        //         isMoving = false;

        //         this.emit('posChanged', this.calcConnectors());

        //     }
        // });

        // this._draggable.addEventListener("dragend", event => {
        //     isMoving = false;
        // })

        let isMoving = false;
        let newLeft, newTop;
        let offsetH = 0, offsetW = 0;

        this._draggable.addEventListener("mousedown", event => {



            newTop = event.clientY - a._draggable.getBoundingClientRect().top;
            newLeft = event.clientX - a._draggable.getBoundingClientRect().left;

            offsetH = newTop;
            offsetW = newLeft;

            this._draggable.style.zIndex = "100";


            isMoving = true;


        })



        this._parent._controlsDiv.addEventListener("mousemove", event => {

            newTop = event.clientY - a._parent._controlsDiv.getBoundingClientRect().top;
            newLeft = event.clientX - a._parent._controlsDiv.getBoundingClientRect().left;


            newTop -= offsetH;
            newLeft -= offsetW;


            if (isMoving) {
                setDevicePosition();
            }

        });



        function setDevicePosition() {
            // check visor bounds

            let dropZoneLeft = a._parent._controlsDiv.offsetLeft - 60;
            let dropZoneTop = a._parent._controlsDiv.offsetTop - 10;
            let dropZoneWidth = a._parent._controlsDiv.getBoundingClientRect().width - 304;
            let dropZoneHeight = a._parent._controlsDiv.getBoundingClientRect().height - 76;

            // verify and adapt shot x and y positions
            if (newLeft < dropZoneLeft) { newLeft = dropZoneLeft }
            if (newLeft > dropZoneWidth) { newLeft = dropZoneWidth }
            if (newTop < dropZoneTop) { newTop = dropZoneTop }
            if (newTop > dropZoneHeight) { newTop = dropZoneHeight }

            let position = a._checkCollision(newLeft, newTop);

            a._draggable.style.left = (position.newLeft) + "px";
            a._draggable.style.top = (position.newTop) + "px";

            a.left = (position.newLeft);
            a.top = (position.newTop);

            // a._draggable.style.left = (newLeft) + "px";
            // a._draggable.style.top = (newTop) + "px";


            // a.left = (newLeft);
            // a.top = (newTop);

            a.NotifyProperty("left");
            a.NotifyProperty("top");

            a.emit('posChanged', a.calcConnectors());
        }

        document.addEventListener("mouseup", event => {
            a._draggable.style.zIndex = "10";
            if (isMoving) {

                let position;
                
                if (a.top > (a._parent._controlsDiv.getBoundingClientRect().height - 76)) {
                    position = a._checkCollision(a.left, a.top, "up");
                }
                else {
                    position = a._checkCollision(a.left, a.top, "down");

                }

                a._draggable.style.left = position.newLeft + "px";
                a._draggable.style.top = position.newTop + "px";
                a.left = (position.newLeft);
                a.top = (position.newTop);
                a.NotifyProperty("left");
                a.NotifyProperty("top");

                a.emit('posChanged', a.calcConnectors());

            }


            isMoving = false;
        });





        // As we are using CSS transforms (in tailwind CSS), it is not possible to set an element fixed to the browser viewport.
        // A workaround is to move the modal element out of the elements styled by the transform, and move it back when done.
        this._topLevelParent._controlsDiv.prepend(this._modalDeviceDetails);


        // do this when clicking the modal close button
        this._modalDeviceDetails.addEventListener('hidden', (e) => {
            this._modalContainer.append(this._modalDeviceDetails);
        })


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

    _setVolume() {
        if (!this._sliderActive) {
            this._volume_slider.style.top = `${this._sliderBottom - this.volume / this.maxVolume * this._sliderRange}px`;
        }
        this._volume_slider.value = this.volume;
        this._rangeBullet.innerHTML = Math.round(this.volume * 100) + " %";
    }

    showSliderValue() {
        this._rangeBullet.innerHTML = Math.round(this._volume_slider.value * 100) + " %";
    }

    _checkCollision(newLeft, newTop, direction = "") {
        // Check for collision with other child elements
        let collision = true;
        // let dropZoneLeft = this._parent._controlsDiv.offsetLeft - 60;
        // let dropZoneTop = this._parent._controlsDiv.offsetTop - 10;
        // let dropZoneWidth = this._parent._controlsDiv.getBoundingClientRect().width - 304;
        // let dropZoneHeight = this._parent._controlsDiv.getBoundingClientRect().height - 76;
        let dropZoneLeft = this._parent._controlsDiv.offsetLeft - 60;
        let dropZoneTop = this._parent._controlsDiv.offsetTop - 10;
        let dropZoneWidth = this._parent._controlsDiv.offsetWidth + 50;
        let dropZoneHeight = this._parent._controlsDiv.offsetHeight;

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