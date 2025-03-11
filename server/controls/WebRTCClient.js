let { dm } = require("../modular-dm");
const { Server } = require("socket.io");
const express = require("express");
const http = require("http");
const path = require("path");
process.chdir(__dirname);
// -------------------------------------
// Class declaration
// -------------------------------------

class WebRTCClient extends dm {
    constructor() {
        super();
        this.url = "http://localhost:8889/test";
        this.title = "name";
        this.displayName = "WebRTCClient";
        this.appPort = 2000;
        this.reload = false;
        this._app = undefined;
        this._http = undefined;
        this._io = undefined;
        this.run = false; // Run command to be set by external code to request the control to start.
        this.SetAccess("run", { Get: "none", Set: "none" });
        this.moduleEnabled = true; // Enable or disable individual module
    }

    Init() {
        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on("reload", (reload) => {
            if (reload && this._parent.runCmd && this.moduleEnabled) {
                this.run = false;
                setTimeout(() => {
                    this.run = this._parent.runCmd;
                }, 1000);
            }
        });

        this.on(
            "run",
            (run) => {
                if (run && this.moduleEnabled) {
                    this._start_webApp();
                } else if (!run) {
                    this._stop_webApp();
                }
            },
            { immediate: true }
        );

        // Subscribe to parent (router) run command
        this._parent.on(
            "runCmd",
            (run) => {
                setTimeout(() => {
                    this.moduleEnabled && (this.run = run);
                }); // timeout added to give the subclasses a time to add their event subscribers to the run event before the event is emited
            },
            { immediate: true, caller: this }
        );

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
    }

    _start_webApp() {
        if (!this._app) {
            this._app = express();
            this._http = http.createServer(this._app);

            try {
                this._http.listen(this.appPort, () => {
                    this._parent._log(
                        "INFO",
                        `${this._controlName} (${this.displayName}) - WebRTC WebApp running on http://*: ${this.appPort}`
                    );
                });

                // Serve the default file
                this._app.get("/", (req, res) => {
                    res.sendFile(
                        path.join(__dirname, "/../../webRTC-client/index.html")
                    );
                });

                // Serve all the files
                this._app.use(
                    express.static(path.join(__dirname, "/../../webRTC-client"))
                );

                // -------------------------------------
                // Socket.io communication with WebRTC WebApp
                // -------------------------------------
                this._io = new Server(this._http);

                this._io.on("connect", (socket) => {
                    socket.emit("data", this.Get());
                });

                this._http.once("error", (err) => {
                    if (err.code == "EADDRINUSE") {
                        this._parent._log(
                            "FATAL",
                            `${this._controlName} (${this.displayName}) - Unable to start WebRTC WebApp: ${err.message}`
                        );
                        this._stop_webApp();
                    }
                });
            } catch (err) {
                this._parent._log(
                    "FATAL",
                    `${this._controlName} (${this.displayName}) - Unable to start WebRTC WebApp: ${err.message}`
                );
            }
        }
    }

    // close web APP and close socket
    _stop_webApp() {
        if (this._app) {
            this._parent._log(
                "INFO",
                `${this._controlName} (${this.displayName}) - Closing WebRTC WebApp running on http://*: ${this.appPort}`
            );
            this._http.close();
            this._app = undefined;
            this._io = undefined;
            this._http = undefined;
        }
    }
}

// Export class
module.exports = WebRTCClient;
