// -------------------------------------
// External libraries
// -------------------------------------

const express = require('express');
const path = require('path');
const session = require('express-session');
const fs = require('fs');
// manager-ui
const manager = express();
const managerHTTP = require('http').createServer(manager);
const manageio = require('socket.io')(managerHTTP);
const cookieParser = require('cookie-parser');
// router.js
const router = express();
const routerHTTP = require('http').createServer(router);
const routerio = require('socket.io')(routerHTTP);

//===================================================
// Startup logic manager-ui
//===================================================

managerHTTP.listen(8082, () => {
    console.log('Client Web server: listening on *:8082');
});

manager.use("/", express.static(path.join(__dirname, "/manager_web-ui")));

// Serve Client page 
manager.get('/', (req, res) => {
    res.sendFile(__dirname + '/manager_web-ui/manager-ui.html');
});

//===================================================
// Startup logic router.js socket coms
//===================================================

routerHTTP.listen(8083, () => {
    console.log('router socket server: listening on *:8083');
});

//===================================================
// Socket.io to manager-ui.js
//===================================================

// -------------------------------------
// Socket.io authentication
// -------------------------------------

//===================================================
// Socket.io to router.js
//===================================================

// -------------------------------------
// Socket.io authentication
// -------------------------------------

routerio.use((socket, next) => {
    // get router token
    const token = socket.handshake.auth.token;

    // read tokens from file
    let tokens = readTokens();

    // if token does not exisist
    if (tokens[token] == undefined) {
        return next(new Error("Invalid token to connect to manager"));
    }
    next();
});

routerio.on("connection", (socket) => {
    
});

//===================================================
// File handling
//===================================================

function readTokens(){
    try {
        // read token file
        let raw = fs.readFileSync('manager_server/tokens.json');
        // pase json file
        let data = JSON.parse(raw);
        // return list of tokens 
        return data;
    } catch (err) {
        console.log(err);
        // create file if it does not exsist
        if (err.message == "ENOENT: no such file or directory, open 'tokens.json'") {
            let tokens = JSON.stringify({"Your tonken1": {description:""}, "Your tonken2": {description:""}, "...": {description:""}}, null, 2); //pretty print

            try {
                // create file
                fs.writeFileSync("manager_server/tokens.json", tokens);
            } catch (err) {
                console.log(err);
            }
        }
    };    
};