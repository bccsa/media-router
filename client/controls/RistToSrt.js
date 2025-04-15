const _Rist = require("controls/RIST/rist");

class RistToSrt extends _uiClasses(_routerChildControlBase, SrtBase, _Rist) {
    constructor() {
        super();
    }

    get html() {
        return this._ristHtml(super.html).replace(
            "%cardHtml%",
            `
            <div class="w-full items-center justify-items-center justify-center">
                <div class="text-center align-top font-semibold text-base">RIST to SRT</div>
            </div>
        `
        );
    }

    Init() {
        super.Init();
        this.setHeaderColor("#00c39f");

        // init SRT Specific
        this._SrtInit();
        this._RistInit();
    }
}
