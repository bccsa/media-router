/**
 * This class should only be used as a super class for router child controls.
 * Additional modal HTML content should be added through super.html.replace('%modalHtml%','Your additional HTML');
 * Additional control card HTML content should be added through super.html.replace('%cardHtml%','Your additional HTML');
 * Also run super.Init() in the overridden Init() function.
 */
class _routerChildControlBase extends ui {
    constructor() {
        super();
        this.description = "";
        this.displayName = "New " + this.controlType;
        this.showControl = true;        // show control on local client
        this.displayOrder = 0;          // Sort order on local client
        this.left = 50;
        this.top = 50;
        this.width = 326.4;
        this.height = 93.6;
        this._left = this.left;  // Internal left position tracking
        this._top = this.top;    // Internal top position tracking
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_draggable}" class="paAudioBase-main-card absolute">
            <!--    TOP HEADING CONTAINER    -->
            <div id="@{_heading}" class="paAudioBase-card-heading overflow-hidden">
        
                <!--    NAME     -->
                <div class="col-span-2">
                    <div class="font-medium text-lg" title="@{description}">@{displayName}</div>
                </div>
        
                <!--    SETTINGS BUTTON     -->
                <button class="paAudioBase-btn-settings" type="button" title="Settings"
                    data-bs-toggle="modal" data-bs-target="#@{_modalDeviceDetails}"></button>
        
            </div>
        
            <div class="paAudioBase-card-body">
                <!-- CARD HTML added by extended controls  -->
                %cardHtml%
            </div>
        </div>

        <!--    MODAL DEVICE    -->
        <div id="@{_modalDeviceDetails}" class="paAudioBase-modal modal fade select-none" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog paAudioBase-modal-dialog">
                <div class="paAudioBase-modal-content">
        
                    <div class="paAudioBase-modal-header">
                        <div class="mr-4 flex justify-start">
        
                            <!--    DUPLICATE    -->
                            <button id="@{_btnDuplicate}" class="paAudioBase-btn-duplicate" type="button"
                                data-bs-dismiss="modal" title="Duplicate device"></button>
        
                            <!--    DELETE   -->
                            <button id="@{_btnDelete}" class="paAudioBase-btn-delete" type="button" data-bs-dismiss="modal"
                                title="Delete device"></button>
        
                        </div>
                        <h5 class="paAudioBase-modal-heading">@{displayName}</h5>
                        <button class="paAudioBase-modal-btn-close" type="button" data-bs-dismiss="modal"
                            aria-label="Close"></button>
                    </div>
        
                    <div class="paAudioBase-modal-body">
        
                        <!--    DISPLAY NAME      -->
                        <div class="w-full mb-1 mr-4">
                            <div class="mr-4 w-full">
                                <label for="@{_displayName}" class="mb-2">Display Name: </label>
                                <input id="@{_displayName}" class="paAudioBase-text-area" type="text" maxlength="30"
                                    placeholder="Your display name" title="Device display name" value="@{displayName}" />
                            </div>
                        </div>
        
                        <!--    DESCRIPTION TEXT AREA     -->
                        <div class="w-full mb-1 mr-4">
                            <label for="@{_description}" class="mb-2">Description:</label>
                            <textarea id="@{_description}" class="paAudioBase-text-area" rows="1" cols="3"
                                title="Device description" placeholder="Your description" value="@{description}"></textarea>
                        </div>
        
                        <!--    GENERAL SETTINGS     -->
                        <div class="w-full mb-1 flex ">
        
                            <!--    SHOW CONTROL CHECKBOX      -->
                            <div class="w-1/2 mr-2 mb-2 flex">
                                <input id="@{_showControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox"
                                    checked="@{showControl}" />
                                <label for="@{_showControl}" class=""
                                    title="Indicates that the front end should show the control">Show on local client</label>
                            </div>
        
                            <!--    DISPLAY ORDER      -->
                            <div class="w-1/4 mr-3">
                                <label for="@{_displayOrder}" class="mb-2">Display Order:</label>
                                <input id="@{_displayOrder}" class="paAudioBase-pos-number-input" type="number" min="0"
                                    oninput="validity.valid||(value='')" title="Display order in the client WebApp."
                                    name="displayOrder" step="1" value="@{displayOrder}">
                            </div>
        
                            <!-- <div class="w-1/4 mr-3"></div>
                            <div class="w-1/4 mr-3"></div>
                            <div class="w-1/4"></div> -->
                        </div>
        
                        <!-- MODAL HTML added by extended controls  -->
                        %modalHtml%
                    </div>
        
                    <div class="paAudioBase-modal-footer"></div>
                </div>
            </div>
        </div>
        
        <div id="@{_externalControls}">
            <!-- Place external controls (e.g. connector lines etc.) in this div -->
        </div>
        `;
    }

    Init() {
        // Set initial values
        let position = this._checkCollision(this.left, this.top, "down");
        this._draggable.style.left = position.newLeft + "px";
        this._draggable.style.top = position.newTop + "px";
        this.left = (position.newLeft);
        this.top = (position.newTop);

        this._draggable.style.offsetHeight = this.height;
        this._draggable.style.offsetWidth = this.width;

        let control = this;

        // Delete control
        this._btnDelete.addEventListener('click', (e) => {
            // Show message box
            this.emit('messageBox',
                {
                    buttons: ["Cancel", "Yes"],
                    title: `Delete ${control.displayName}?`,
                    text: 'Are you sure you want to delete the device?',
                    img: 'paAudioBase-modal-img-delete',
                    callback: function (data) {
                        if (data == 'Yes') {
                            control._notify({ remove: true });
                            control.SetData({ remove: true });
                        }
                    }
                }, 'top');
        });

        // Duplicate control
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

            // Create new control
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

        //-------------- Dragging --------------------

        let isMoving = false;
        let newLeft, newTop;
        let offsetH = 0, offsetW = 0;

        // Mouse down on heading, start to move the control position
        this._heading.addEventListener("mousedown", event => {

            newTop = event.clientY - control._heading.getBoundingClientRect().top;
            newLeft = event.clientX - control._heading.getBoundingClientRect().left;
            offsetH = newTop;
            offsetW = newLeft;

            this._draggable.style.zIndex = "100";
            isMoving = true;
        })


        // Mouse move on the container
        this._parent._controlsDiv.addEventListener("mousemove", event => {

            newTop = event.clientY - control._parent._controlsDiv.getBoundingClientRect().top;
            newLeft = event.clientX - control._parent._controlsDiv.getBoundingClientRect().left;
            newTop -= offsetH;
            newLeft -= offsetW;

            if (isMoving) {
                setPosition();
            }
        });

        // Change Device position as the mouse is moving
        function setPosition() {

            // check container bounds
            let dropZoneLeft = control._parent._controlsDiv.offsetLeft;
            let dropZoneTop = control._parent._controlsDiv.offsetTop - 10;
            let dropZoneWidth = control._parent._controlsDiv.getBoundingClientRect().width - 304;
            let dropZoneHeight = control._parent._controlsDiv.getBoundingClientRect().height - 76;

            // verify and adapt newLeft and newTop positions
            if (newLeft < dropZoneLeft) { newLeft = dropZoneLeft }
            if (newLeft > dropZoneWidth) { newLeft = dropZoneWidth }
            if (newTop < dropZoneTop) { newTop = dropZoneTop }
            if (newTop > dropZoneHeight) { newTop = dropZoneHeight }

            // Check Collision so that no Device stack on each other
            let position = control._checkCollision(newLeft, newTop);

            control._draggable.style.left = (position.newLeft) + "px";
            control._draggable.style.top = (position.newTop) + "px";

            control._left = position.newLeft;
            control._top = position.newTop;

            // Emit event posChanged, so that the Lines are updated when Device is moved
            control.emit('posChanged', control.calcConnectors(control._top, control._left));
        }

        // Mouse up on document, stop to move the Device position
        document.addEventListener("mouseup", event => {
            control._draggable.style.zIndex = "10";
            if (isMoving) {

                let position;
                // Check if the Device is at the upper or lower bound and adjust accordingly
                if (this._top > (control._parent._controlsDiv.getBoundingClientRect().height - 90)) {
                    position = control._checkCollision(this._left, this._top, "up");
                }
                else {
                    position = control._checkCollision(this._left, this._top, "down");
                }

                control._draggable.style.left = position.newLeft + "px";
                control._draggable.style.top = position.newTop + "px";
                control.left = position.newLeft;
                control.top = position.newTop;
                this._left = position.newLeft;
                this._top = position.newTop

                control.emit('posChanged', control.calcConnectors(this._top, this._left));
            }

            isMoving = false;
        });



        this.on('left', left => {
            this._draggable.style.left = left + "px";
            this.emit('posChanged', this.calcConnectors(this.top, left));
            this._left = left;
        });

        this.on('top', top => {
            this._draggable.style.top = top + "px";
            this.emit('posChanged', this.calcConnectors(top, this.left));
            this._top = top;
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
    calcConnectors(top, left) {
        return {
            leftConnector: { top: (top + (this._draggable.clientHeight / 2) + 4), left: left + 5 },
            rightConnector: { top: (top + (this._draggable.clientHeight / 2) + 4), left: (left + (this._draggable.clientWidth) + 5) }
        };
    }

    // Set the different colors for the Devices
    /**
     * Set the header color of the control's card
     * @param {string} color - CSS color
     */
    setHeaderColor(color) {
        this._heading.style.backgroundColor = color;
    }

    // Check for collision with other Device elements
    _checkCollision(newLeft, newTop, direction = "") {
        let collision = true;

        let dropZoneLeft = this._parent._controlsDiv.offsetLeft;
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