let { dm } = require('../modular-dm');
const { Server } = require('socket.io');
const express = require('express');
const http = require('http');
const path = require('path');
process.chdir(__dirname);
// -------------------------------------
// Class declaration
// -------------------------------------

class WebRTCClient extends dm {
    constructor() {
        super();
        this.url = 'http://localhost:8889/test';
        this.title = 'name';
        this.displayName = 'WebRTCClient';
        this.appPort = 2000;
        this.reload = false;
        this._app = undefined;
        this._http = undefined;
        this._io = undefined;
    }

    Init() {

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('reload', reload => {
            if (reload && this._parent.run) {
                this._start_webApp();
            } else if (!reload) {
                this._stop_webApp();
            }
        });

        this._parent.on('run', run => {
            if (run) {
                this._start_webApp();
            } else if (!run) {
                this._stop_webApp();
            }
        }, { immediate: true });

        // this._parent.on(this._controlName, data => {
        //     if (this._io) {
        //         this._io.emit('data', data.Get());
        //     }
        // })

    }

    _start_webApp() {
        if (!this._app) {
            this._app = express();
            this._http = http.createServer(this._app);

            try {
                this._http.listen(this.appPort, () => {
                    this._parent._log('INFO', `${this._controlName} (${this.displayName}) - WebRTC WebApp running on http://*: ${this.appPort}`); 
                });
            
                // Serve the default file
                this._app.get('/', (req, res) => {
                    res.sendFile(path.join(__dirname, '/../../webRTC-client/index.html'));
                });
            
                // Serve all the files
                this._app.use(express.static(path.join(__dirname, '/../../webRTC-client')));
            
            } catch (err) {
                this._parent._log('FATAL', `${this._controlName} (${this.displayName}) - Unable to start WebRTC WebApp: ${err.message}`);
            } 

            // -------------------------------------
            // Socket.io communication with WebRTC WebApp
            // -------------------------------------
            this._io = new Server(this._http);

            this._io.on('connect', socket => {
                socket.emit('data', this.Get());
            })
        }
    }

    // close web APP and close socket
    _stop_webApp() {
        if (this._app) {
            this._parent._log('INFO', `${this._controlName} (${this.displayName}) - Closing WebRTC WebApp running on http://*: ${this.appPort}`); 
            this._http.close();
            this._app = undefined;
            this._io = undefined;
            this._http = undefined;
        }
    }

}

// Export class
module.exports = WebRTCClient;