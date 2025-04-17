const Resources = require("/controls/Router/resources");
const Logs = require("/controls/Router/logs");
const { html } = require("/controls/Router/html");

class Router extends _uiClasses(ui, Resources, Logs) {
    constructor() {
        super();
        this.deviceType = "Router";
        this.description = "";
        this.startupState = true; // true = Auto (manager selected state); false = Start in stopped state.
        this.startupDelayTime = 3000; // milliseconds
        this.run = false;
        this.password = "";
        this.displayName = "New Router";
        this.online = false;
        this.sources = []; // Array with PulseAudio sources
        this.sinks = []; // Array with PulseAudio sinks
        this.paLatency = 50; // PulsAudio modules latency (applied to each dynamically loaded PulseAudio module). Lower latency gives higher PulseAudio CPU usage.
        this.displayOrder = 100;
        this.height = 700;
        this.width = 1500;
        this.scale = 1;
        this.resetCmd = false; // Reset router process
        this.restartCmd = false; // Restart router device
        this.startLocalCTR = false; // Start local control panel (When the MR starts) (!!! This script was build for bookworm / noble / bullseye, if you have a diffrent release update teh script in ./media-router/server/scripts/start-localCTR.sh)
    }

    get html() {
        return html(this.name);
    }

    Init() {
        this.InitResources();
        this.InitLogs();
        // Set initial values
        this._toggleSettingContainer();

        // Workaround: set page height and width after css is applied
        setTimeout(() => {
            this._controlsDiv.style.height = this.height + "px";
            this._controlsDiv.style.width = this.width + "px";
        }, 100);

        this._height.addEventListener("change", (e) => {
            if (this._height.value <= 450) {
                this._height.value = 450;
                this.height = 450;
            }
        });

        this._width.addEventListener("change", (e) => {
            if (this._width.value <= 450) {
                this._width.value = 450;
                this.width = 450;
            }
        });

        this.on("width", (width) => {
            if (this.scale <= 1) {
                this._controlsDiv.style.width = this.width / this.scale + "px";
            } else {
                this._controlsDiv.style.width = this.width * this.scale + "px";
            }
        });

        this.on("height", (height) => {
            if (this.scale <= 1) {
                this._controlsDiv.style.height =
                    this.height / this.scale + "px";
            } else {
                this._controlsDiv.style.height =
                    this.height * this.scale + "px";
            }
        });

        this._btnSettings.addEventListener("click", (e) => {
            this._toggleSettingContainer();
        });

        this._btnExit.addEventListener("click", (e) => {
            this._toggleSettingContainer();
        });

        this._btnDeleteRouter.addEventListener("click", (e) => {
            this._notify({ remove: true });
            this.SetData({ remove: true });
        });

        this._btnAddDevice.addEventListener("click", (e) => {
            // Get unique random name
            let type = this._deviceType.value;
            function randomName() {
                return type + "_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this[name]) {
                name = randomName();
            }

            // Create new audio device
            this.SetData({ [name]: { controlType: this._deviceType.value } });
            this.on(name, (control) => {
                // send newly created audio device's data to manager
                this._notify({ [name]: control.GetData() });
            });
        });

        this._btnDuplicate.addEventListener("click", (e) => {
            // Get unique random name
            function randomName() {
                return "router_" + Math.round(Math.random() * 10000);
            }

            let name = randomName();
            while (this._parent[name]) {
                name = randomName();
            }

            // Create new router
            let dup = this.GetData();
            delete dup.name;
            delete dup.online;
            delete dup.run;
            dub.cpuUsage = 0;
            dub.cpuTemperature = 0;
            dub.memoryUsage = 0;
            dup.name = name; // Manually set name. This is used by the manager service as a unique router socket identification.

            dup.displayName += " (copy)";

            this._parent.SetData({ [name]: dup });

            // send newly created router's data to manager
            this._parent._notify({ [name]: dup });

            // Close group
            this._details.removeAttribute("open");
        });

        /**
         * Export and download the router configuration
         */
        this._btnExport.addEventListener("click", (e) => {
            // Get unique random name
            function genName(name) {
                return name + "_backup_" + Math.round(Math.random() * 100);
            }

            let name = genName(this.name);
            while (this._parent[name]) {
                name = genName(this.name);
            }

            let data = this.GetData({ sparse: false });
            delete data.name;
            delete data.online;
            delete data.run;
            data.cpuUsage = 0;
            data.cpuTemperature = 0;
            data.memoryUsage = 0;
            data.name = name; // Manually set name. This is used by the manager service as a unique router socket identification.
            data.displayName = data.displayName + " (backup)";
            let blob = new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
            });
            let url = URL.createObjectURL(blob);
            let a = document.createElement("a");
            a.href = url;
            a.download = `${data.name}.router-config.mr`;
            a.click();
            URL.revokeObjectURL(url);
        });

        // Handle property changes
        this.on(
            "online",
            (online) => {
                this._checkOnline();

                if (online) {
                    this._btnReset.style.display = "";
                    this._btnRestart.style.display = "";
                } else {
                    this._btnReset.style.display = "none";
                    this._btnRestart.style.display = "none";
                    // set CPU usage and temp to 0 when offline
                    this.cpuUsage = 0;
                    this.cpuTemperature = 0;
                    this.memoryUsage = 0;
                }
            },
            { immediate: true }
        );

        //----------------------Scaling-----------------------------//
        this.on(
            "scale",
            (scale) => {
                this._setScale();
            },
            { immediate: true }
        );

        // Toggle reset command
        this._btnReset.addEventListener("click", (e) => {
            this.resetCmd = false;
            this.resetCmd = true;
        });

        // Toggle restart command
        this._btnRestart.addEventListener("click", (e) => {
            this.restartCmd = false;
            this.restartCmd = true;
        });
        //----------------------Scaling-----------------------------//

        //----------------------Help Modal-----------------------------//

        // Load help from MD
        let _this = this;
        fetch("controls/Router/README.md")
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("Network response was not ok");
                }
                return response.text();
            })
            .then(function (fileContent) {
                let converter = new showdown.Converter();
                let html = converter.makeHtml(fileContent);
                _this._modalHelp_md.innerHTML = html;
            })
            .catch(function (error) {
                console.error("There was a problem fetching the file:", error);
            });

        //----------------------Help Modal-----------------------------//
    }

    _setScale() {
        if (this._controlsDiv) {
            this._controlsDiv.style.transform =
                "scale(" + this.scale + "," + this.scale + ")"; // Apply the scale transformation to the control element

            this._controlsDiv.style.height = this.height / this.scale + "px";
            this._controlsDiv.style.width = this.width / this.scale + "px";
        }
    }

    _toggleSettingContainer() {
        if (this._settingsContainer.style.display === "none") {
            this._btnSettings.style.display = "none";
            this._settingsContainer.style.display = "block";
        } else {
            this._settingsContainer.style.display = "none";
            this._btnSettings.style.display = "block";
        }
    }
}
