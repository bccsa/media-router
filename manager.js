// -------------------------------------
// External libraries
// -------------------------------------

const express = require('express');
const path = require('path');
const app = express();
const webserver = require('http').createServer(app);

//===================================================
// Startup logic Client Page
//===================================================

webserver.listen(8080, () => {
    console.log('Client Web server: listening on *:8080');
});

app.use("/", express.static(path.join(__dirname, "/manager_web-ui")));

// Serve Client page 
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/manager_web-ui/manager-ui.html');
});
