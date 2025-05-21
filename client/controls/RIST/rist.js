const { ristHtml, ristStatsHtml } = require("controls/RIST/html");

class Rist {
    constructor() {
        this.udpSocket = 40000;
        this.buffer = 75;
    }

    _ristHtml(h) {
        return h
            .replace(
                "%modalHtml%",
                `
                ${this.SrtBaseHtml()}

                ${ristHtml()}

                <div class="rounded border-solid border-black border-2 mb-2">
                    <button id="@{_addRist}" class="w-full py-2 px-4">Add RIST link</button>
                </div>

                <div id="@{_controlsDiv}"> </div>
            `
            )
            .replace(
                "<!--  %SrtStatsHtml%  -->",
                `${this.SrtStatsHtml()} ${ristStatsHtml()}`
            );
    }

    _RistInit() {
        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD("controls/RIST/README.md"); // Load additional MD
        //----------------------Help Modal-----------------------------//

        this._addRist.addEventListener("click", (e) => {
            let name = `rist_${this._generateUuid()}`;

            this.once(name, (data) => {
                // send newly created router's data to manager
                this._notify({ [name]: data.Get() });
            });

            this.Set({
                [name]: {
                    controlType: "RISTConfig",
                    type: this.controlType,
                },
            });
        });

        //----------------------Port validation-----------------------------//
        this.on(
            "udpSocket",
            async () => {
                // wait for prop to be ready
                while (!this._udpSocketWarning || !this.udpSocket)
                    await new Promise((res) => setTimeout(res, 1000));
                // only check for listen
                const warn = this._parent.publishPort(
                    this.name,
                    "udp",
                    this.udpSocket,
                    "udpSocket"
                );

                if (!warn) {
                    this._udpSocketWarning.style.display = "none";
                    return;
                }
                this._udpSocketWarning.innerHTML = warn;
                this._udpSocketWarning.style.display = "block";
            },
            { immediate: true }
        );
        //----------------------Port validation-----------------------------//
    }
}

module.exports = Rist;
