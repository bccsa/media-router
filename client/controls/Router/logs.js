class Logs {
    constructor() {
        this.log = []; // controls output logs
        this.logMessage = []; // Last log message
        this.fetchLog = false; // Toggle from front end to fetch log on page load
        this.logINFO = false; // log level enabled/ disabled
        this.logERROR = false; // log level enabled/ disabled
        this.logFATAL = true; // log level enabled/ disabled
        this.logLimit = 100; // max number of logs in list
    }

    InitLogs() {
        //----------------------Logging-----------------------------//
        // emit fetch log event
        this.fetchLog = true;

        // listen for logs
        this.on(
            "log",
            () => {
                this._createLog();
            },
            { immediate: true }
        );

        this._log.style.display = "none";

        this.on("logINFO", (val) => {
            this._createLog();
        });
        this.on("logERROR", (val) => {
            this._createLog();
        });
        this.on("logFATAL", (val) => {
            this._createLog();
        });

        this.on("logMessage", (msg) => {
            // Add log to history
            this.log.push(msg);

            // scrolling
            let isScrolled = true;
            if (
                this._log.clientHeight + this._log.scrollTop >=
                this._log.scrollHeight - 20
            )
                isScrolled = false;

            this._addLog(msg);

            if (!isScrolled) this._log.scrollTop = this._log.scrollHeight;
        });

        this._console.addEventListener("click", (e) => {
            if (this._log.style.display == "none")
                this._log.style.display = "block";
            else this._log.style.display = "none";

            this._log.scrollTop = this._log.scrollHeight;
        });
        //----------------------Logging-----------------------------//
    }

    _addLog(msg) {
        // clear old log items when log is full
        while (this.log.length > this.logLimit) {
            this.log.shift();
        }

        // add log to html
        if (this[`log${msg[0]}`]) {
            let span = document.createElement("span");
            span.innerHTML = `${msg[1]}\n`;
            this._log.append(span);
            while (this._log.childElementCount > this.logLimit) {
                this._log.removeChild(this._log.children[0]);
            }
        }
    }

    _createLog() {
        // clear console
        while (this._log.firstChild) {
            this._log.removeChild(this._log.firstChild);
        }
        this.log.forEach((msg) => {
            this._addLog(msg);
        });
    }
}

module.exports = Logs;
