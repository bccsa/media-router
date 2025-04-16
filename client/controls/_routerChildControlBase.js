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
        this.showControl = true; // show control on local client
        this.displayOrder = 0; // Sort order on local client
        this.left = 50;
        this.top = 50;
        this.width = 0;
        this.height = 0;
        this._left = this.left; // Internal left position tracking
        this._top = this.top; // Internal top position tracking
        this.reload = false; // Reload configuration command. Stops and starts the control to apply changes.
        this.Help_md = ""; // Help info
        this.md_queue = []; // queue to load md files, to keep them in the right seq.
        this.moduleEnabled = true; // Enable or disable individual module
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_draggable}" class="paAudioBase-main-card absolute">
            <!--    TOP HEADING CONTAINER    -->
            <div id="@{_heading}" class="paAudioBase-card-heading grid grid-cols-8 overflow-hidden">
        
                <!--    NAME     -->
                <div class="col-span-6">
                    <div class="font-medium text-lg truncate max-w-[175px]" title="@{description}">@{displayName}</div>
                </div>

                <!--    SrtStats BUTTON    -->
                <button id="@{_btnSrtStats}" class="paAudioBase-btn-srtstats col-start-7 hidden" type="button" title="SrtStats"
                    data-bs-toggle="modal" data-bs-target="#@{_modalDeviceDetails}"></button>

                <!--    SETTINGS BUTTON     -->
                <button id="@{_btnSettings}" class="paAudioBase-btn-settings col-start-8" type="button" title="Settings"
                    data-bs-toggle="modal" data-bs-target="#@{_modalDeviceDetails}"></button>
        
            </div>
        
            <div id="@{_cardBody}" class="paAudioBase-card-body">
                <!-- CARD HTML added by extended controls  -->
                %cardHtml%
            </div>
        </div>

        <!--    MODAL DEVICE    -->
        <div id="@{_modalDeviceDetails}" class="paAudioBase-modal modal fade select-none" tabindex="-1" aria-hidden="true">
            <div id="@{_modalDevice}" class="modal-dialog modal-xl paAudioBase-modal-dialog">
                <div class="flex justify-center w-full">

                    <!--  Settings section  -->
                    <div id=@{_SettingsContent} class="paAudioBase-modal-content">
            
                        <div class="paAudioBase-modal-header">
                            <div class="flex flex-shrink-0 items-center justify-between">
                                <span class="appFrame-control-name">${this.controlType}</span>
                                <div class="flex flex-row">
                                    <!--    RELOAD    -->
                                    <button id="@{_btnReload}" class="paAudioBase-btn-reload" type="button"
                                        title="Reload configuration. This will live-restart the component if the router is running."></button>

                                    <!--    DUPLICATE    -->
                                    <button id="@{_btnDuplicate}" class="paAudioBase-btn-duplicate" type="button"
                                        data-bs-dismiss="modal" title="Duplicate device"></button>
                
                                    <!--    DELETE   -->
                                    <button id="@{_btnDelete}" class="paAudioBase-btn-delete" type="button" data-bs-dismiss="modal"
                                        title="Delete device"></button>

                                    <!--    HELP MODAL     -->
                                    <button id="@{_btnHelp}" class="router-btn-help" type="button"
                                        title="Help"></button>

                                    <!--    CLOSE    -->
                                    <button class="paAudioBase-modal-btn-close" type="button" data-bs-dismiss="modal"
                                    aria-label="Close" title="Close"></button>
                                </div>
                            </div>        
                        </div>
            
                        <div class="paAudioBase-modal-body">
                            <!--    TOGGLE ENABLE/DISABLE     -->
                            <div class="flex text-[15px] justify-self-end">
                                <label for="@{_moduleEnabled}" class="router-label">Disable</label>
                                <div class="form-check form-switch">
                                    <input id="@{_moduleEnabled}" class="router-toggle" type="checkbox"
                                    role="switch" title="Enable or disable an individual module" checked="@{moduleEnabled}">
                                    <label for="@{_moduleEnabled}" class="router-label">Enable</label>
                                </div>
                            </div>
            
                            <!--    DISPLAY NAME      -->
                            <div class="w-full mb-1 mr-4">
                                <div class="mr-4 w-full">
                                    <label for="@{_displayName}" class="mb-2">Display Name: </label>
                                    <input id="@{_displayName}" class="paAudioBase-text-area" type="text" maxlength="60"
                                        placeholder="Your display name" title="Device display name" value="@{displayName}" />
                                </div>
                            </div>
            
                            <!--    DESCRIPTION TEXT AREA     -->
                            <div class="w-full mb-2 mr-4">
                                <label for="@{_description}" class="mb-2">Description:</label>
                                <textarea id="@{_description}" class="paAudioBase-text-area" rows="1" cols="3"
                                    title="Device description" placeholder="Your description" value="@{description}"></textarea>
                            </div>
            
                            <!--    GENERAL SETTINGS     -->
                            <div class="w-full mb-3 flex ">
            
                                <!--    SHOW CONTROL CHECKBOX      -->
                                <div class="w-1/2 mr-3 flex">
                                    <input id="@{_showControl}" class="mr-2 mt-1 h-4 w-4" type="checkbox"
                                        checked="@{showControl}" />
                                    <label for="@{_showControl}" class=""
                                        title="Indicates that the front end should show the control">Show on local client</label>
                                </div>
            
                                <!--    DISPLAY ORDER      -->
                                <div class="w-1/2  flex">
                                    <label for="@{_displayOrder}" class="w-1/2 mr-3">Display Order:</label>
                                    <input id="@{_displayOrder}" class="paAudioBase-pos-number-input w-1/2" type="number" min="0"
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
            
                        <div class="paAudioBase-modal-footer h-10"></div>

                    </div>

                    <!--  Help section  -->
                    <div id="@{_modalHelp}" class="paAudioBase-sub-modal">

                        <div class="paAudioBase-modal-header">
                            <div class="flex flex-shrink-0 items-center justify-between">
                                <span class="appFrame-control-name">Help</span>
                                <div class="flex flex-row">
                                    <!--    CLOSE    -->
                                    <button id="@{_btnHelpDismiss}" class="router-modal-btn-close" type="button"aria-label="Close"></button>
                                </div>
                            </div>
                        </div>

                        <div class="paAudioBase-modal-body">
                            <div id="@{_modalHelp_md}" class="prose">
                            </div>
                        </div>

                        <div class="paAudioBase-modal-footer h-10">
                            
                        </div>
                    </div>

                    <div>
                        <div id="@{_modalStats}" class="paAudioBase-sub-modal hidden">
                            <!--  %SrtStatsHtml%  -->
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
        // Set initial values
        let position = this._checkCollision(this.left, this.top, "down");
        this._draggable.style.left = position.newLeft + "px";
        this._draggable.style.top = position.newTop + "px";
        this.left = position.newLeft;
        this.top = position.newTop;
        this._left = this.left;
        this._top = this.top;

        // this.height = this._draggable.getBoundingClientRect().height;
        // this.width = this._draggable.getBoundingClientRect().width;

        // this._draggable.offsetHeight = this.height;
        // this._draggable.offsetWidth = this.width;

        let control = this;

        // recalculate card body on resize
        const divResizeObserver = new ResizeObserver(() => {
            this.height =
                this._draggable.getBoundingClientRect().height /
                this._parent.scale;
            this.width =
                this._draggable.getBoundingClientRect().width /
                this._parent.scale;
        });
        divResizeObserver.observe(this._cardBody);

        // Delete control
        this._btnDelete.addEventListener("click", (e) => {
            // Show message box
            this.emit(
                "messageBox",
                {
                    buttons: ["Cancel", "Yes"],
                    title: `Delete ${control.displayName}?`,
                    text: "Are you sure you want to delete the device?",
                    img: "paAudioBase-modal-img-delete",
                    callback: function (data) {
                        if (data == "Yes") {
                            control._notify({ remove: true });
                            control.SetData({ remove: true });
                        }
                    },
                },
                "top"
            );
        });

        // Duplicate control
        this._btnDuplicate.addEventListener("click", (e) => {
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
            let position = this._checkCollision(dup.left, dup.top + 70, "down");
            dup.top = position.newTop;
            dup.left = position.newLeft;

            this._parent.SetData({ [name]: dup });

            // send newly created audio device's data to manager
            this._parent._notify({ [name]: dup });
        });

        // Reload control
        this._btnReload.addEventListener("click", (e) => {
            this.reload = false; // reset state if stuck to true
            this.reload = true; // Toggle to true. Client router will reset reload prop to false.
        });

        //-------------- Dragging --------------------

        let isMoving = false;
        let newLeft, newTop;
        let offsetH = 0,
            offsetW = 0;

        // Mouse down on heading, start to move the control position
        this._heading.addEventListener("mousedown", (event) => {
            if (event.target !== this._btnSettings) {
                newTop =
                    event.clientY -
                    control._heading.getBoundingClientRect().top +
                    4.8; // this._parent.scale;
                newLeft =
                    event.clientX -
                    control._heading.getBoundingClientRect().left +
                    4.8; // this._parent.scale;
                offsetH = newTop;
                offsetW = newLeft;

                this._draggable.style.zIndex = "100";
                isMoving = true;
            }
        });

        // Mouse move on the container
        this._parent._scrollDiv.addEventListener("mousemove", (event) => {
            newTop =
                event.clientY -
                control._parent._controlsDiv.getBoundingClientRect().top; /// this._parent.scale;
            newLeft =
                event.clientX -
                control._parent._controlsDiv.getBoundingClientRect().left; /// this._parent.scale;
            newTop -= offsetH;
            newLeft -= offsetW;

            newTop /= this._parent.scale;
            newLeft /= this._parent.scale;

            if (isMoving) {
                setPosition();
            }
        });

        // Change Device position as the mouse is moving
        function setPosition() {
            // check container bounds
            let dropZoneLeft = control._parent._controlsDiv.offsetLeft;
            let dropZoneTop = control._parent._controlsDiv.offsetTop - 10;
            let dropZoneWidth =
                control._parent._controlsDiv.scrollWidth - control.width + 22;
            let dropZoneHeight =
                control._parent._controlsDiv.scrollHeight - control.height - 10;

            // verify and adapt newLeft and newTop positions
            if (newLeft < dropZoneLeft) {
                newLeft = dropZoneLeft;
            }
            if (newLeft > dropZoneWidth) {
                newLeft = dropZoneWidth;
            }
            if (newTop < dropZoneTop) {
                newTop = dropZoneTop;
            }
            if (newTop > dropZoneHeight) {
                newTop = dropZoneHeight;
            }

            // Check Collision so that no Device stack on each other
            let position = control._checkCollision(newLeft, newTop);

            control._draggable.style.left = position.newLeft + "px";
            control._draggable.style.top = position.newTop + "px";

            control._left = position.newLeft;
            control._top = position.newTop;

            // Emit event posChanged, so that the Lines are updated when Device is moved
            control.emit(
                "posChanged",
                control.calcConnectors(control._top, control._left)
            );
        }

        // Mouse up on document, stop to move the Device position
        document.addEventListener("mouseup", (event) => {
            control._draggable.style.zIndex = "10";
            if (isMoving) {
                let position;
                // Check if the Device is at the upper or lower bound and adjust accordingly
                if (
                    this._top >
                    control._parent._controlsDiv.scrollHeight - 90
                ) {
                    position = control._checkCollision(
                        this._left,
                        this._top,
                        "up"
                    );
                } else {
                    position = control._checkCollision(
                        this._left,
                        this._top,
                        "down"
                    );
                }

                control._draggable.style.left = position.newLeft + "px";
                control._draggable.style.top = position.newTop + "px";
                control.left = position.newLeft;
                control.top = position.newTop;
                this._left = position.newLeft;
                this._top = position.newTop;

                control.emit(
                    "posChanged",
                    control.calcConnectors(this._top, this._left)
                );
            }

            isMoving = false;
        });

        this.on("left", (left) => {
            this._draggable.style.left = left + "px";
            this.emit("posChanged", this.calcConnectors(this.top, left));
            this._left = left;
        });

        this.on("top", (top) => {
            this._draggable.style.top = top + "px";
            this.emit("posChanged", this.calcConnectors(top, this.left));
            this._top = top;
        });

        //-------------------------------------------------------------------------

        // As we are using CSS transforms (in tailwind CSS), it is not possible to set an element fixed to the browser viewport.
        // A workaround is to move the modal element out of the elements styled by the transform.
        this._topLevelParent._controlsDiv.prepend(this._modalDeviceDetails);

        // Delete modal when this control is removed
        this.on("remove", () => {
            this._modalDeviceDetails.remove();
        });

        //----------------------Scale-----------------------------//
        this._parent.on(
            "scale",
            (scale) => {
                this._setScale();
            },
            { immediate: true, caller: this }
        );
        //----------------------Scale-----------------------------//

        //----------------------Help Modal-----------------------------//
        this.Help_md = "";
        this._modalHelp.style.display = "none";
        this._btnHelp.addEventListener("click", (e) => {
            this._toggleHelp();
        });
        this._btnHelpDismiss.addEventListener("click", (e) => {
            this._toggleHelp();
        });
        this._btnSettings.addEventListener("click", (e) => {
            this._modalHelp.style.display = "none";
        });
        this.on("Help_md", (e) => {
            let converter = new showdown.Converter();
            let html = converter.makeHtml(this.Help_md);
            this._modalHelp_md.innerHTML = html;
        });
        //----------------------Help Modal-----------------------------//

        //----------------------Enable / Disable Modal-----------------------------//

        this.on(
            "moduleEnabled",
            (e) => {
                if (e) {
                    this._draggable.style["opacity"] = "1";
                } else {
                    this._draggable.style["opacity"] = "0.5";
                }
            },
            { immediate: true }
        );

        //----------------------Enable / Disable Modal-----------------------------//
    }

    /**
     * Toggle help section
     */
    _toggleHelp() {
        if (this._modalHelp.style.display == "none") {
            this._modalHelp.style.display = "block";
        } else {
            this._modalHelp.style.display = "none";
        }
    }

    /**
     * Load help md file into help section
     * @param {String} _path - path to file
     */
    _loadHelpMD(_path) {
        this.md_queue.push(_path);
        if (this.md_queue.length == 1) {
            this._processMDQueue();
        }
    }

    _processMDQueue() {
        if (this.md_queue.length > 0) {
            let _path = this.md_queue.shift();
            let _this = this;
            fetch(_path)
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error("Network response was not ok");
                    }
                    return response.text();
                })
                .then(function (fileContent) {
                    _this.Help_md = `${fileContent}\n${_this.Help_md}\n`;
                    _this._processMDQueue();
                })
                .catch(function (error) {
                    console.error(
                        "There was a problem fetching the file:",
                        error
                    );
                    _this._processMDQueue();
                });
        }
    }

    _setScale() {
        if (this._draggable) {
            this.height =
                this._draggable.getBoundingClientRect().height /
                this._parent.scale;
            this.width =
                this._draggable.getBoundingClientRect().width /
                this._parent.scale;

            this.calcConnectors(this.top, this.left);

            // console.log(this.height + " <> " + this.width + " ^ " + this.top + " < " + this.left  );
        }
    }

    /**
     * Calculate connector positions
     * @returns
     */
    calcConnectors(top, left) {
        return {
            leftConnector: { top: top + this.height / 2 + 4, left: left + 5 },
            rightConnector: {
                top: top + this.height / 2 + 4,
                left: left + this.width + 5,
            },
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
        let dropZoneWidth = this._parent._controlsDiv.scrollWidth + 22;
        let dropZoneHeight = this._parent._controlsDiv.scrollHeight - 40;

        while (collision) {
            collision = false;

            Object.values(this._parent._controls).forEach((control) => {
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
                    if (
                        newLeft < childLeft + childWidth &&
                        newLeft + this.width > childLeft &&
                        newTop < childTop + childHeight &&
                        newTop + this.height > childTop
                    ) {
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
                            newTop = childTop - this.height - 2;
                        } else if (direction == "down") {
                            newTop = childTop + childHeight + 2;
                        }

                        // Check border bounds and limit movement
                        newLeft = Math.max(
                            dropZoneLeft,
                            Math.min(
                                newLeft,
                                dropZoneLeft + dropZoneWidth - this.width
                            )
                        );
                        newTop = Math.max(
                            dropZoneTop,
                            Math.min(
                                newTop,
                                dropZoneTop + dropZoneHeight - this.height
                            )
                        );

                        if (
                            newLeft === dropZoneLeft ||
                            newLeft ===
                                dropZoneLeft + dropZoneWidth - this.width ||
                            newTop === dropZoneTop ||
                            newTop ===
                                dropZoneTop + dropZoneHeight - this.height
                        ) {
                            collision = false;
                        }
                    }
                }
            });
        }

        return {
            newLeft,
            newTop,
        };
    }
}
