const fetch = require('node-fetch');

/**
 * Media MTX API Class
 */
class MediaMTX {
    constructor(host) {
        this.host = host;    // API url
        this.prevPath = '';                     // Keep track of last saved path
    }

    /**
     * Update path/ source
     * @param {String} path - publish path
     * @param {String} source - source (url/ publisher - will publish stream to path)
     * @param {String} passphrase - srt encryption on src
     */
    addPath(path, source, passphrase) {
        return new Promise((resolve, reject) => {
            this._removePath(this.prevPath)
            .then(res => {
                this.prevPath = path;
                return this._removePath(path); // double check that current path is removed
            })
            .then(res => {
                return this._addPath(path, source, passphrase);
            })
            .then(res => {
                resolve(res);
            })
        })
    }

    /**
     * Remove path from server
     * @param {String} path 
     */
    _removePath(path) {
        return this._Post(`/v2/config/paths/remove/${path}`);
    }

    /**
     * Add a new path 
     * @param {String} path 
     * @param {String} source 
     * @param {String} passphrase 
     */
    _addPath(path, source, passphrase) {
        let data = {};
        if (passphrase) { data.srtReadPassphrase = passphrase };
        data.source = source;
        return this._Post(`/v2/config/paths/add/${path}`, data);
    } 


    //----------------------HTTP Controller-----------------------------//
    /**
     * HTTP post
     * @param {String} path - Url path
     * @param {Object} body - JSON body
     * @returns {Object} - JSON Object
     */
    _Post(path, body = {}) {
        return new Promise((resolve, reject) => {
            fetch(`${this.host}${path}`, {
                method: 'post',
                body: JSON.stringify(body),
                headers: {'Content-Type': 'application/json'}
            }).then(res => {
                resolve(res);
            }).catch(err => {
                console.log(err.message);
                resolve({});
            })  
        })
    }

    /**
     * HTTP get
     * @param {String} path - Url path
     * @returns {Object} - JSON Object
     */
    _Get(path) {
        return new Promise((resolve, reject) => {
            fetch(`${this.host}${path}`)
            .then(res => {
                return res.json();
            }).then(res => {
                resolve(res);
            }).catch(err => {
                console.log(err.message);
                resolve({});
            })  
        })
    }
    //----------------------API Controller-----------------------------//
}

module.exports.MediaMTX = MediaMTX;