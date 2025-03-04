// ======================================
// Audio Router
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// External libraries
// -------------------------------------

const express = require("express");
const path = require("path");
let { dmTopLevelContainer } = require("./modular-dm");
const process = require("process");
const io = require("socket.io-client");
const { configManager } = require("./configManager");
const fs = require("fs");
const { Client } = require("./dgram-comms");

// Set path to runtime directory
process.chdir(__dirname);

// -------------------------------------
// Configuration management
// -------------------------------------
let profileConf;
// Get config file path from passed argument
if (process.argv.length > 2) {
    // Load config file from disk
    profileConf = new configManager(process.argv[2], "defaultProfileConf.json");
} else {
    profileConf = new configManager(
        "profileConf.json",
        "defaultProfileConf.json"
    );
}

function setProfileDetails(property, value) {
    // Listen for connection details updates, and update the local profile manager
    let p = Object.values(profileConf.config).find((p) => p.selected);
    if (p) {
        p[property] = value;
        profileConf.save();
    }
}
// -------------------------------------
// Manager socket.io connection
// -------------------------------------
var manager_io;

let reconnectTimer;
let firstConnect = true;
/**
 * Connect to the manager's socket.io server
 * @param {string} url
 */
function manager_connect(managerHost, managerPort, username, password, oldUrl) {
    if (!managerHost || managerHost == "") {
        const _url = new URL(oldUrl);
        managerHost = _url.hostname;
        managerPort = _url.port;
    }

    if (!managerHost || !managerPort || !username || !password) return;

    const client = new Client({
        port: managerPort,
        address: managerHost,
        clientID: username,
        encryptionKey: password,
    });

    // Cancel reconnect timer if existing before (re)connecting.
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }

    // Clear existing connection
    if (manager_io) {
        manager_io.disconnect();
    }

    manager_io = client.getSocket();

    manager_io.on("connected", () => {
        console.log("Connected to manager.");
        // Send PulseAudio sources and sinks to manager
        controls.router.NotifyProperty("sources");
        controls.router.NotifyProperty("sinks");
    });

    // set data from manager to router controls
    manager_io.on("data", (data) => {
        // remove initial (first connect) data
        if (firstConnect && !controls.router.startupState) {
            delete data.run;
            controls.router.NotifyProperty("run"); // Return stopped state to manager
        }

        controls.router.Set(data);
        clientIO.emit("data", data);

        firstConnect = false;
    });
}

// -------------------------------------
// Startup logic
// -------------------------------------
var controls = new dmTopLevelContainer("../controls");

let cString; // previous connection details

/**
 * Create / re-create a new Router instance
 */
function loadRouter() {
    let s = Object.values(profileConf.config).filter((t) => t.selected);

    // Ignore if more than one profile is selected
    if (s.length == 1) {
        let p = s[0];
        if (
            p &&
            p.managerHost +
                p.managerPort +
                p.managerUrl +
                p.username +
                p.password !=
                cString
        ) {
            cString =
                p.managerHost +
                p.managerPort +
                p.managerUrl +
                p.username +
                p.password;

            // Remove the current router configuration
            if (controls.router) {
                controls.router.Set({ remove: true });
            }

            // Validate startup delay time
            let t;
            if (p.startupDelayTime) {
                t = p.startupDelayTime;
            } else {
                t = 2000;
            }

            // Validate startup state
            let s;
            if (p.startupState != undefined) {
                s = p.startupState;
            } else {
                s = true;
            }

            // Create a new router
            controls.Set({
                router: {
                    controlType: "Router",
                    startupDelayTime: t,
                    startupState: s,
                },
            });
        }
    }
}

controls.on(
    "router",
    (router) => {
        // Load the selected profile from the local profile manager
        let c = Object.values(profileConf.config).find((t) => t.selected);
        if (c) {
            manager_connect(
                c.managerHost, // default
                c.managerPort || 3000, // default
                c.username,
                c.password,
                c.managerUrl // this is fallback used  in case client has net yet set the new Host and port
            );
        }

        // forward data from router controls to manager
        router.on("data", (data) => {
            if (manager_io) {
                manager_io.emit("data", data, {
                    guaranteeDelivery: false,
                });
            }
        });

        // Update profile details if changed on manager
        router.on("displayName", (displayName) => {
            setProfileDetails("username", displayName);
            loadRouter();
        });
        router.on("password", (password) => {
            setProfileDetails("password", password);
            loadRouter();
        });
        router.on("startupDelayTime", (startupDelayTime) => {
            setProfileDetails("startupDelayTime", startupDelayTime);
        });
        router.on("startupState", (startupState) => {
            setProfileDetails("startupState", startupState);
        });
    },
    { immediate: true }
);

loadRouter();

// -------------------------------------
// Client WebApp Express webserver
// -------------------------------------

const clientApp = express();
const clientHttp = require("http").createServer(clientApp);

try {
    // Serve the default file
    clientApp.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "/../local-client/index.html"));
    });

    // Serve all the files
    clientApp.use(express.static(path.join(__dirname, "/../local-client")));

    clientHttp.listen(8081, () => {
        eventLog("Client WebApp running on *:8081");
    });
} catch (err) {
    eventLog(`Unable to start Client WebApp: ${err.message}`);
}

// -------------------------------------
// Client WebApp Socket.IO
// -------------------------------------

const clientIO = require("socket.io")(clientHttp);

controls.on(
    "router",
    (router) => {
        clientIO.on("connection", (socket) => {
            // Send initial (full) state
            socket.emit("data", controls.router.Get({ sparse: false }));

            socket.on("data", (data) => {
                // Send data to router
                if (controls.router) {
                    controls.router.Set(data);
                }

                // Send data to other clients
                socket.broadcast.emit("data", data);

                // Send data to manager
                if (manager_io) {
                    manager_io.emit("data", data, {
                        guaranteeDelivery: false,
                    });
                }
            });
        });

        // Forward data from router to local clients
        router.on("data", (data) => {
            clientIO.emit("data", data);
        });
    },
    { immediate: true }
);

// -------------------------------------
// Profileman WebApp Express webserver
// -------------------------------------

const profilemanApp = express();
const profilemanHttp = require("http").createServer(profilemanApp);

try {
    // Serve the default file
    profilemanApp.get("/", (req, res) => {
        res.sendFile(path.join(__dirname, "/../local-profileman/index.html"));
    });

    // Serve all the files
    profilemanApp.use(
        express.static(path.join(__dirname, "/../local-profileman"))
    );

    profilemanHttp.listen(8082, () => {
        eventLog("Profileman WebApp running on *:8082");
    });
} catch (err) {
    eventLog(`Unable to start Profileman WebApp: ${err.message}`);
}

// -------------------------------------
// Profileman WebApp Socket.IO
// -------------------------------------

const profilemanIO = require("socket.io")(profilemanHttp);
profilemanIO.on("connection", (socket) => {
    socket.emit("data", profileConf.config);

    socket.on("data", (data) => {
        profileConf.append(data);
        profileConf.save();

        // Reload router if needed
        loadRouter();
    });
});

// -------------------------------------
// ENV File manager
// -------------------------------------
function loadEnv() {
    let _path = "./.env";
    if (process.argv.length > 3) {
        _path = process.argv[3];
    }
    try {
        let _md = fs.readFileSync(_path);
        profileConf.append({ envFile: _md.toString(), envFileErr: "" });
        profilemanIO.emit("data", { envFile: _md.toString(), envFileErr: "" });
    } catch (err) {
        // try to create the file if it does not exsists
        if (err.code == "ENOENT") {
            try {
                fs.writeFileSync(_path, profileConf.config.envFile);
            } catch (err) {
                profileConf.append({ envFile: "", envFileErr: err.message });
                profilemanIO.emit("data", {
                    envFile: "",
                    envFileErr: err.message,
                });
            }
        } else {
            profileConf.append({ envFile: "", envFileErr: err.message });
            profilemanIO.emit("data", { envFile: "", envFileErr: err.message });
        }
    }
}
loadEnv();

function saveEnv(e) {
    let _path = "./.env";
    if (process.argv.length > 3) {
        _path = process.argv[3];
    }
    try {
        fs.writeFileSync(_path, e);
    } catch (err) {
        profileConf.append({ envFileErr: err.message });
        profilemanIO.emit("data", { envFileErr: err.message });
    }
}

profileConf.on("envFile", (e) => {
    saveEnv(e);
});

// -------------------------------------
// Event logging
// -------------------------------------

// Event log
// controls.on('log', message => {
//     eventLog(message);
// });

function eventLog(message) {
    console.log(message);
}

// -------------------------------------
// Cleanup
// -------------------------------------

process.on("exit", cleanup);
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

var _exit = false;
function cleanup() {
    if (controls && controls.router) {
        controls.router.runCmd = false;
    }

    if (!_exit) {
        setTimeout(() => {
            _exit = true;
            process.exit();
        }, 500);
    }
}
