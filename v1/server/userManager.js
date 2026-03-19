const fs = require('fs');
const crypto = require('crypto');

/**
 * User management
 */
class userManager {
    /**
     * User management
     */
    constructor() {
        this.path = './userpass'
        this.userHash = this._load();
    }

    /**
     * Loads a configuration file from disk. If the file does not exists, it returns a default configuration.
     */
    _load() {
        try {
            console.log(`Loading userpass from ${this.path}`);

            var data = fs.readFileSync(this.path);

            // Parse JSON file and return
            return (JSON.parse(data));
        }
        catch (err) {
            // If userpass file does not exsist, return empty user and pass
            console.log(`Unable to load userpass from ${this.path}, using default userpass`);
            return {admin: this.createHash("admin")};
        }
    }

    /**
     * Save userpass to userpass file save in the runtime dir
     */
    save() {
        try {
            fs.writeFileSync(this.path, JSON.stringify(this.userHash));
        } catch (err) {
            console.log('Unable to save ' + this.path + ': ' + err.message);
        }
    }

    /**
     * Authenticate user
     * @param {String} username - Cleartext username
     * @param {String} password - Cleartext password
     */
    authUser(username, password) {
        let _hash = this.createHash(`${username}${password}`)
        return _hash == this.userHash[username];
    }  
    
    /**
     * Update stored userpass 
     * @param {String} username - Cleartext username
     * @param {String} password - Cleartext password
     */
    updateUser(username, password) {
        let _hash = this.createHash(`${username}${password}`)
        this.userHash[username] = _hash;
        this.save();
    }

    /**
     * Create md5 Hash 
     * @param {String} string - String to create md5 has h from 
     */
    createHash(string) {
        return crypto.createHash('md5').update(string).digest("hex");
    }
}

module.exports.userManager = userManager;