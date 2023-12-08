class WebRTCClient extends _routerChildControlBase {
    constructor() {
        super();
        this.appPort = 2000;
        this.title = '';
    }

    get html() {
        return super.html.replace('%modalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">WebRTC Client WebApp</div>
        </div>

        <!--    WebApp Title      -->
        <div class="w-full mb-1 mr-4">
            <div class="mr-4 w-full">
                <label for="@{_title}" class="mb-2">WebAPP Title: </label>
                <input id="@{_title}" class="paAudioBase-text-area" type="text" maxlength="60"
                    placeholder="Your WebApp name" title="WebAPP Title" value="@{title}" />
            </div>
        </div>

        <div class="w-full mb-2 flex ">
            <!-- Web port  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_appPort}" class="form-label inline-block mb-2 mr-2">WebApp Port:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_appPort}" 
                    title="WebApp port" name="WebApp port" step="1" class="WebRTCClient-pos-number-input"
                    value="@{appPort}"
                >
            </div>

            <!-- SRT Latency  --> 
            <div class="w-1/3 mr-4 flex flex-col">
            </div>

            <div class="w-1/3"></div>

        </div>

        <div class="rounded border-solid border-black border-2 mb-2">
            <button id="@{_addPlayer}" class="w-full py-2 px-4">Add WebRTC Player</button>
        </div>

        <div id="@{_controlsDiv}"> </div>

        `).replace('%cardHtml%',`
        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">WebRTC Client WebApp</div>
        `);
    }


    Init() {
        super.Init();
        this.setHeaderColor('#0D6EFD');

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/WebRTCClient.md');
        //----------------------Help Modal-----------------------------//

        this._addPlayer.addEventListener('click', e => {
            let name = `player_${this._generateUuid()}`;

            this.once(name, data => {
                // send newly created router's data to manager
                this._notify({ [name]: data.Get()});
            })
            
            this.Set({
                [name]: {
                    controlType: 'WebRTCPlayer',
                    url: "http://localhost:1234/player",
                    playerName: 'WebRTC Player'
                }
            })
        })
    }
}