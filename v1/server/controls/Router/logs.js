class Logs {
    constructor() {
        this.logMessage = []; // Last log message
        this.log = []; // complet list of recent logs
        this.logLimit = 100; // max amout of logs in list
        this.fetchLog = false; // Toggle from fron end to fetch log on page load
    }

    InitLogs() {
        // toggle on front end to emit the log
        this.on("fetchLog", (res) => {
            if (res) {
                this.NotifyProperty("log");
                this.fetchLog = false;
            }
        });
    }

    /**
     * Controls logger
     * @param {String} level - log level
     * @param {*} message - log message
     */
    _log(level, message) {
        let date = new Date().toLocaleString("en-ZA");
        let msg = [level, `${date} | ${level}: \t${message.trim()}`];
        console.log(msg[1]);
        this.logMessage = msg;
        this.log.push(msg);
        // clear old log items when log is full
        while (this.log.length > this.logLimit) {
            this.log.shift();
        }
    }
}

module.exports = Logs;
