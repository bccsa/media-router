class WebRTCClient extends ui {
    constructor() {
        super();
        this.title = '';
    }

    get html() {
        return `
        <div class="absolute p-2 flex flex-col top-0 left-0 right-0 bottom-0">
            <!--    Title       -->
            <div class="items-center text-2xl text-white w-full text-center mb-4 mt-2">
                <h1>@{title}</h1>
            </div>

            <!--    Players     -->
            <div id="@{_controlsDiv}" class="">
            
            </div>

            <div class="flex-1 relative w-full">
                <p class="absolute bottom-0 align-text-bottom w-full text-center text-white">Supported web browsers: Google Chrome, Microsoft Edge, Safari, Brave.</p>
            </div>
        </div>
        `;
    }

    Init() {

    }

}
