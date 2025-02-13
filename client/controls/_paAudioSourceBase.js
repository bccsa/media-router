class _paAudioSourceBase extends _paAudioBase {
    constructor() {
        super();
        this.destinations = [];
        this._destinations_prev = [];
    }

    get html() {
        return super.html.replace(
            "%additionalHtml%",
            `
        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">Routing</div>
        </div>

        <!-- Destinations  -->
        <div class="w-full mr-4">
            <label for="@{_destinations}" class="form-label inline-block mb-2">Destinations:</label>
        </div>

        <!--    Destination Checkboxes    -->
        <div id="@{_checkboxes}" class="w-full flex flex-wrap mr-2 mb-2 justify-start"></div>

        <!-- Additional controls  --> 
        %additionalHtml%
        `
        );
    }

    Init() {
        super.Init();

        this._parent.on("newChildControl", (c) => {
            this._addDestination(c);
        });

        let a = this;
        function showHideDest(destinations) {
            a._destinations_prev.forEach((dest) => {
                let line = "line_" + a.name + "To" + dest;
                let check = "dst_" + dest;
                if (!destinations.find((t) => t == dest) && a[line]) {
                    a[check].value = false;
                    a[line].Hide();
                }
            });

            // Clear prev destinations list
            a._destinations_prev = [];

            destinations.forEach((dest) => {
                let line = "line_" + a.name + "To" + dest;
                let check = "dst_" + dest;

                if (a[line]) {
                    a[check].value = true;
                    a[line].Show();
                }

                // Update previous dest list
                a._destinations_prev.push(dest);
            });
        }

        this.on("destinations", (destinations) => {
            showHideDest(destinations);
        });

        // Set initial destination lines
        showHideDest(this.destinations);

        // Add destination if new _audioInputDevice control is added to the parent
        this.on("init", () => {
            // Scan for valid destination
            Object.values(this._parent._controls).forEach((control) => {
                this._addDestination(control);
            });
        });

        this.on("newChildControl", (control) => {
            try {
                if (control instanceof checkBox) {
                    let dstName = control.name.replace("dst_", "");
                    let dstControl = this._parent[dstName];
                    if (dstControl) {
                        this._addDestination(dstControl);
                    }
                }
            } catch {}
        });

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/_paAudioSourceBase.md");
        //----------------------Help Modal-----------------------------//
    }

    //Add destination if new _paAudioSinkBase control is added to the parent
    _addDestination(dstControl) {
        try {
            if (
                ((dstControl.controlType == "SoundDucking" ||
                    dstControl.controlType == "SoundProcessor") &&
                    this.name != dstControl.name) ||
                dstControl instanceof _paAudioSinkBase
            ) {
                let check = "dst_" + dstControl.name;
                let line = "line_" + this.name + "To" + dstControl.name;

                let existing = this[check] != undefined;

                // Create new checkbox
                if (!existing) {
                    // Create new checkBox control if the checkbox is not already existing
                    this.once(check, (control) => {
                        // send newly created audio device's data to manager
                        control.on("check", (value) => {
                            const index = this.destinations.indexOf(
                                dstControl.name
                            );
                            if (value) {
                                // Add Destination to array if it is not existing
                                if (index == -1) {
                                    this.destinations.push(dstControl.name);
                                    this[line].Show();
                                    this.NotifyProperty("destinations");
                                }
                            } else {
                                // Remove Destination from array if it is existing
                                if (index != -1) {
                                    this.destinations.splice(index, 1);
                                    this[line].Hide();
                                    this.NotifyProperty("destinations");
                                }
                            }
                        });

                        dstControl.on("displayName", (displayName) => {
                            control.label = displayName;
                        });
                    });

                    let sourceCon = this.calcConnectors(this.top, this.left);
                    let dstCon = dstControl.calcConnectors(
                        dstControl.top,
                        dstControl.left
                    );

                    this.SetData({
                        [check]: {
                            controlType: "checkBox",
                            label: dstControl.displayName,
                            color: dstControl._heading.style.backgroundColor,
                            parentElement: "_checkboxes",
                            hideData: true,
                        },
                    });

                    this.once(line, (lineControl) => {
                        this.on("posChanged", (sourceCon) => {
                            lineControl.top = sourceCon.rightConnector.top;
                            lineControl.left = sourceCon.rightConnector.left;
                        });
                        dstControl.on("posChanged", (dstCon) => {
                            lineControl.bottom = dstCon.leftConnector.top;
                            lineControl.right = dstCon.leftConnector.left;
                        });

                        // Set checkbox value to true if it in the destination array
                        const index = this.destinations.indexOf(
                            dstControl.name
                        );
                        if (index != -1) {
                            this[check].value = true;
                        }

                        // Set initial visibility based on checkbox checked status
                        lineControl.visible = this[check].value;
                    });

                    this.SetData({
                        [line]: {
                            controlType: "line",
                            top: sourceCon.rightConnector.top,
                            left: sourceCon.rightConnector.left,
                            bottom: dstCon.leftConnector.top,
                            right: dstCon.leftConnector.left,
                            parentElement: "_externalControls",
                            hideData: true,
                        },
                    });
                } else {
                    // Subscribe to control remove event to remove destination checkbox controls
                    dstControl.once("remove", (control) => {
                        this.SetData({ [check]: { remove: true } });
                        this.SetData({ [line]: { remove: true } });
                    });
                }
            }
        } catch {}
    }
}
