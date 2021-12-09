// -------------------------------------
// External libraries
// -------------------------------------

const express = require('express');
const path = require('path');
const fs = require('fs');
// manager-ui
const manager = express();
const managerHTTP = require('http').createServer(manager);
const managerio = require('socket.io')(managerHTTP);
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

managerio.use((socket, next) => {
    // get router token
    const username = socket.handshake.auth.username;
    const password = socket.handshake.auth.password;

    // read login from file
    let login = readAuth("managerLogin.json");

    // if username does not exisist
    if (login[username] != undefined) {
        // if username exsists check if password is valid
        if (login[username].password != password){
            // close connection
            return next(new Error("Invalid login to connect to manager"));
        }
    } else {
        // close connection
        return next(new Error("Invalid login to connect to manager"));
    }
    next();
});

managerio.on("connection", (socket) => {
    console.log('Manager page connected ' + socket.request.connection.remoteAddress)
    
});

//===================================================
// Socket.io to router.js
//===================================================

// -------------------------------------
// Socket.io authentication
// -------------------------------------

routerio.use((socket, next) => {
    // get router token
    const username = socket.handshake.auth.username;
    const password = socket.handshake.auth.password;

    // read login from file
    let login = readAuth("routerLogin.json");

    // if username does not exisist
    if (login[username] != undefined) {
        // if username exsists check if password is valid
        if (login[username].password != password){
            // close connection
            return next(new Error("Invalid login to connect to manager"));
        }
    } else {
        // close connection
        return next(new Error("Invalid login to connect to manager"));
    }
    next();
});

routerio.on("connection", (socket) => {
    console.log('Router connected ' + socket.request.connection.remoteAddress)
    
});

//===================================================
// File handling
//===================================================

// read login from routerLogin.json/managerLogin.json
function readAuth(filename){
    try {
        // read login file
        let raw = fs.readFileSync(`manager_server/${filename}`);
        // pase json file
        let data = JSON.parse(raw);
        // return list of tokens 
        return data;
    } catch (err) {
        console.log(err);
        // create file if it does not exsist
        if (err.message == `ENOENT: no such file or directory, open 'manager_server/${filename}'`) {
            let logins = JSON.stringify({"username1": {password:"pass1"}, "username1": {password:"pass1"}, "...": {password:"pass1"}}, null, 2); //pretty print

            try {
                // create file
                fs.writeFileSync(`manager_server/${filename}`, logins);
            } catch (err) {
                console.log(err);
            }
        }
    };    
};