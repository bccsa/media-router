const { ristConfigHtml } = require("controls/RIST/html");

class RISTConfig extends ui {
    constructor() {
        super();
        this.host = "";
        this.port = 1234;
        this.mode = "caller";
        this.cname = "";
        // this.buffermin = 50;
        // this.buffermax = 100;
        this.buffer = 50;
        this.weight = 0;
    }

    get html() {
        return ristConfigHtml();
    }

    Init() {
        // Delete control
        this._btnDelete.addEventListener("click", (e) => {
            // Show message box
            this.emit(
                "messageBox",
                {
                    buttons: ["Cancel", "Yes"],
                    title: `Delete RIST Endpoint?`,
                    text: "Are you sure you want to delete the RIST Endpoint?",
                    img: "paAudioBase-modal-img-delete",
                    callback: function (data) {
                        if (data == "Yes") {
                            this._notify({ remove: true });
                            this.SetData({ remove: true });
                        }
                    }.bind(this),
                },
                "top"
            );
        });

        this.on(
            "mode",
            (m) => {
                if (m == "listener") this._hostDiv.style.display = "none";
                else this._hostDiv.style.display = "block";
            },
            { immediate: true }
        );

        this.on("mode", this.publishPort.bind(this));

        this.on("port", this.publishPort.bind(this), { immediate: true });
    }

    async publishPort() {
        if (this.mode == "listener") {
            // wait for prop to be ready
            while (!this._portWarning || !this.port)
                await new Promise((res) => setTimeout(res, 1000));
            const warn = this._parent._parent.publishPort(
                this._parent.name,
                "udp",
                this.port,
                this.name
            );

            if (!warn) {
                this._portWarning.style.display = "none";
                return;
            }
            this._portWarning.innerHTML = warn;
            this._portWarning.style.display = "block";
        } else {
            this._parent._parent.unpublishPort(
                this._parent.name,
                "udp",
                this.name
            );
            this._portWarning.style.display = "none";
        }
    }
}
