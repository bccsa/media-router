var controls = new uiTopLevelContainer("../controls", "controls");
var socket;

// Add appFrame control
controls.SetData({
    appFrame: {
        controlType: "appFrame",
    },
});

controls.on("appFrame", (appFrame) => {
    // try login from localStorage
    socket = io({
        auth: {
            username: localStorage.getItem("username"),
            password: localStorage.getItem("password"),
        },
    });
    socket_comms();

    appFrame.on("login", (data) => {
        localStorage.setItem("username", data.username);
        localStorage.setItem("password", data.password);
        socket = io({
            auth: { username: data.username, password: data.password },
        });
        socket_comms();

        socket.on("connect_error", (err) => {
            console.log("Unable to connect to manager: " + err.message);
            appFrame._incorrectPassAlert.style.display = "block";
            appFrame._userName.focus();
        });
    });
});

var logOut = false;
function socket_comms() {
    logOut = false;
    var socket_connect = function () {
        console.log("Connected to manager");
        controls.appFrame.logIn();
        controls.appFrame._disconnectAlert.style.display = "none";

        // socket data
        var socket_data = function (data) {
            controls.appFrame.SetData(data);
        };
        socket.on("data", socket_data);

        // controls data
        var controls_data = function (data) {
            socket.emit("data", data.appFrame);
        };
        controls.on("data", controls_data);

        // controls password_change
        var controls_change_password = function (data) {
            socket.emit("change_password", data);
        };
        controls.on("change_password", controls_change_password);

        // socket new_password
        var socket_new_password = function (data) {
            controls.appFrame.emit("new_password", data);
        };
        socket.on("new_password", socket_new_password);

        // Handle messageBox requests
        var controls_messageBox = function (data) {
            controls.SetData({
                msgBox: {
                    controlType: "messageBox",
                    title: data.title,
                    text: data.text,
                    buttons: data.buttons,
                    img: data.img,
                    callback: data.callback,
                },
            });
        };
        controls.on("messageBox", controls_messageBox);

        var controls_disconnect = function () {
            logOut = true;
            socket.disconnect();
        };
        controls.on("disconnect", controls_disconnect);

        // socket disconnect
        socket.on("disconnect", () => {
            controls.appFrame.clearControls();
            if (!logOut)
                controls.appFrame._disconnectAlert.style.display = "flex";

            // remove all event listeners
            socket.off("data", socket_data);
            socket.off("new_password", socket_new_password);
            // socket.off('connect', socket_connect);
            controls.off("data", controls_data);
            controls.off("change_password", controls_change_password);
            controls.off("messageBox", controls_messageBox);
            controls.off("disconnect", controls_disconnect);
        });
    };

    socket.on("connect", socket_connect);

    // listen for build number
    socket.on("build_number", (bn) => {
        controls.appFrame.build_number = bn;
    });
}

//
///- REQUIRE FN https://stackoverflow.com/questions/6971583/node-style-require-for-in-browser-javascript
// equivalent to require from node.js
function require(url) {
    if (url.toLowerCase().substr(-3) !== ".js") url += ".js"; // to allow loading without js suffix;
    if (!require.cache) require.cache = []; //init cache
    var exports = require.cache[url]; //get from cache
    if (!exports) {
        //not cached
        try {
            exports = {};
            var X = new XMLHttpRequest();
            X.open("GET", url, 0); // sync
            X.send();
            if (X.status && X.status !== 200) throw new Error(X.statusText);
            var source = X.responseText;
            // fix (if saved form for Chrome Dev Tools)
            if (source.substr(0, 10) === "(function(") {
                var moduleStart = source.indexOf("{");
                var moduleEnd = source.lastIndexOf("})");
                var CDTcomment = source.indexOf("//@ ");
                if (CDTcomment > -1 && CDTcomment < moduleStart + 6)
                    moduleStart = source.indexOf("\n", CDTcomment);
                source = source.slice(moduleStart + 1, moduleEnd - 1);
            }
            // fix, add comment to show source on Chrome Dev Tools
            source =
                "//@ sourceURL=" + window.location.origin + url + "\n" + source;
            //------
            var module = { id: url, uri: url, exports: exports }; //according to node.js modules
            var anonFn = new Function("require", "exports", "module", source); //create a Fn with module code, and 3 params: require, exports & module
            anonFn(require, exports, module); // call the Fn, Execute the module
            require.cache[url] = exports = module.exports; //cache obj exported by module
        } catch (err) {
            throw new Error("Error loading module " + url + ": " + err);
        }
    }
    return exports; //require returns object exported by module
}
///- END REQUIRE FN
