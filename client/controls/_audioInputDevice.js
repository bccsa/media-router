class _audioInputDevice extends _audioDevice {
    constructor() {
        super();
        this.destinations = []; // Split with comma from string
        this._destinationsList = [];
    }

    get html() {
        return super.html.replace('%additionalHtml%', `
        <!-- Destinations  -->
        <div class="w-full mt-2 mr-4">
            <label for="@{_destinations}" class="form-label inline-block mb-2">Destinations:</label>
        </div>

        <!--    Destination Checkboxes    -->
        <div id="@{_checkboxes}" class="w-full flex flex-wrap mr-2 mb-2 justify-start"></div>

        <!-- Additional controls  --> 
        %additionalHtml%

        `);
    }


    Init() {
        super.Init();
        
        this._parent.on('newChildControl', c => {
            this._addDestination(c);
        });




        // Add destination if new _audioInputDevice control is added to the parent
        this.on('init', () => {
            // Scan for valid destination
            Object.values(this._parent._controls).forEach(control => {
                this._addDestination(control);
            });
        });


        this.on('newChildControl', control => {
            try {
                if (control instanceof checkBox) {
                    let dstName = control.name.replace('dst_', '');
                    let dstControl = this._parent[dstName];
                    if (dstControl) {
                        this._addDestination(dstControl);
                    }
                }
            } catch { }
        });
    }

    //Add destination if new _audioInputDevice control is added to the parent
    _addDestination(dstControl) {
        try {
            if (dstControl instanceof _audioOutputDevice) {
                let check = 'dst_' + dstControl.name;
                let line = 'line_' + this.name + "To" + dstControl.name;
  
                let existing = this[check] != undefined;

                // Create new checkbox
                if (!existing) {
                    // Create new checkBox control if the checkbox is not already existing
                    this.one(check, control => {
                        // send newly created audio device's data to manager
                        // this._notify({ [check]: control.GetData() });

                        control.on('check', value => {

                            const index = this.destinations.indexOf(dstControl.name);  
                            if (value) {
                                this[line].Show();
                                
                                // Add Destination to array if it is not existing
                                if(index == -1)
                                {
                                    this.destinations.push(dstControl.name)
                                    this.NotifyProperty('destinations');
                                }
                                
                            } else {
                                this[line].Hide();

                                // Remove Destination from array if it is existing
                                if(index != -1)
                                {
                                this.destinations.splice(index, 1); 
                                this.NotifyProperty('destinations');
                                }
                            }
                        });
                    });

                    let sourceCon = this.calcConnectors();
                    let dstCon = dstControl.calcConnectors();

                    this.SetData({ [check]: { controlType: "checkBox", label: dstControl.name, parentElement: "_checkboxes", hideData: true } });

                    this.one(line, lineControl => {
                        this.on('posChanged', sourceCon =>{
                            lineControl.top = sourceCon.rightConnector.top;
                            lineControl.left = sourceCon.rightConnector.left;

                        }) 
                        dstControl.on('posChanged', dstCon =>{
                            lineControl.bottom = dstCon.leftConnector.top;
                            lineControl.right = dstCon.leftConnector.left;
                        });

                        // Set checkbox value to true if it in the destination array
                        const index = this.destinations.indexOf(dstControl.name);
                        if(index != -1)
                        {
                            this[check].value = true;
                        }

                        // Set initial visibility based on checkbox checked status
                        if (this[check].value) {
                            lineControl.Show();
                        } else {
                            lineControl.Hide();
                        }
                    })

                    this.SetData({ [line]: { 
                        controlType: "line", 
                        top: sourceCon.rightConnector.top, 
                        left: sourceCon.rightConnector.left,
                        bottom: dstCon.leftConnector.top, 
                        right: dstCon.leftConnector.left, 
                        parentElement: "_externalControls",
                        hideData: true
                    }});

                } else {
                    // Subscribe to control remove event to remove destination checkbox controls
                    dstControl.one('remove', control => {
                        this.SetData({ [check]: { remove: true } });
                        // this._notify({ [check]: { remove: true } });
                        this.SetData({ [line]: { remove: true } });
                        // this._notify({ [line]: { remove: true } });
                    });
                }
            }
        } catch { }
    }
}