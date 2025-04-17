const Rist = require("controls/RIST/rist");

class SrtToRist extends _uiClasses(_routerChildControlBase, SrtBase, Rist) {
    constructor() {
        super();
    }

    get html() {
        return this._ristHtml(super.html).replace(
            "%cardHtml%",
            `
            <div class="w-full items-center justify-items-center justify-center">
                <div class="text-center align-top font-semibold text-base">SRT to RIST</div>
            </div>
        `
        );
    }

    Init() {
        super.Init();
        this.setHeaderColor("#0089c3");

        // init SRT Specific
        this._SrtInit();
        this._RistInit();
    }
}
