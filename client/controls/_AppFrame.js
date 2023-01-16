class _AppFrame extends ui {
    constructor() {
        super();
        this.deviceType = "_AppFrame";
        this._controlsDiv = undefined;
    }

    get html() {
        return `
        <nav
        class="relative w-full h-12 flex flex-wrap justify-between py-2 bg-gray-900 text-gray-200 shadow-lg">
            <div class="container-fluid w-full flex flex-wrap justify-between px-6">
            <div class="container-fluid">
                <a class="mb-4 text-2xl text-white font-['Open-sans']" href="#"
                >Media Router Manager</a
                >
            </div>
            </div>
        </nav>

        
        <div id="${this._uuid}_deviceLists" class="pb-4 pt-2 h-auto w-auto"></div>
        `;

    }

    Init() {
        this._controlsDiv = document.getElementById(`${this._uuid}_deviceLists`);
    }

    
}
