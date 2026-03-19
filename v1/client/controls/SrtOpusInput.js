class SrtOpusInput extends _uiClasses(_paAudioSourceBase, SrtBase) {
    constructor() {
        super();
    }

    get html() {
        return super.html.replace('%additionalHtml%', this.SrtBaseHtml())
        .replace("<!--  %SrtStatsHtml%  -->", this.SrtStatsHtml());
    }


    Init() {
        super.Init();
        this.setHeaderColor('#0D6EFD');

        // init SRT Spesific
        this._SrtInit();

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/SrtOpusInput.md');
        //----------------------Help Modal-----------------------------//
    }
}