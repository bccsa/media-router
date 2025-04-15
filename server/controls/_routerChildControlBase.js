let { dm } = require("../modular-dm");

class _routerChildControlBase extends dm {
    constructor() {
        super();
        this.displayName = ""; // Display name
        this.moduleEnabled = true; // Enable or disable individual module
        this.run = false; // Run command to be set by external code to request the control to start.
        this.SetAccess("run", { Get: "none", Set: "none" });
        this.ready = false; // Ready indication to be set by implementing class when internal processes are running and the module is ready for linking to other modules. This should include e.g. PulseAudio modules, so the implementing control should check if the PulseAudio module exists before setting 'ready' to true.
        this.SetAccess("ready", { Get: "none", Set: "none" });
        this.reload = false; // Reload configuration command. Stops and starts the control to apply changes.
    }

    InitBase() {
        // enable or disable module
        this.on("moduleEnabled", (enabled) => {
            if (enabled) {
                this._parent._log(
                    "INFO",
                    `${this._paModuleName} (${this.displayName}): Enabling module`
                );
                this.run = true;
            } else {
                this._parent._log(
                    "INFO",
                    `${this._paModuleName} (${this.displayName}): Disabling module`
                );
                this.run = false;
            }
        });

        // Subscribe to parent (router) run command
        this._parent.on(
            "runCmd",
            (run) => {
                setTimeout(() => {
                    this.moduleEnabled && (this.run = run);
                }); // timeout added to give the subclasses a time to add their event subscribers to the run event before the event is emitted
            },
            { immediate: true, caller: this }
        );

        // Stop control on removal
        this.on("remove", () => {
            this.ready = false;
            this.run = false;
        });

        // Restart control on reload command
        this.on("reload", (reload) => {
            if (reload) {
                if (this._parent.runCmd && this.moduleEnabled) {
                    this.run = false;
                    setTimeout(() => {
                        this.run = this._parent.runCmd;
                    }, 1000);
                }
            }
            this.reload = false;
        });
    }
}

module.exports = _routerChildControlBase;
