class WebRTCClient extends ui {
    constructor() {
        super();
        this.title = '';
    }

    get html() {
        return `
        <!--    Title       -->
        <div class="w-fit items-center justify-items-center justify-center">
            <div class="text-left align-top font-semibold text-white m-2 ml-4">@{title}</div>
        </div>

        <!--    Players     -->
        <div id="@{_controlsDiv}" class="appFrame_contents w-screen">
        
        </div>
        `;
    }

    Init() {

    }

    pause(){
        Object.values(this._controls).forEach(c => {
            c.pause();
        })
    }

}
