class MediaMTX extends _routerChildControlBase {
    constructor() {
        super();
        this.host = 'http://127.0.0.1:9997';    // API url
        this.path = 'pathName';                 // Path name
        this.source = 'srt.invalid';            // Media Source
    }

    get html() {
        return super.html.replace('%modalHtml%', `

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- Title  -->
        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">MediaMTX Settings</div>
        </div>

        <!-- Path  -->
        <div class="w-full mb-2">
            <label for="@{_host}" class="form-label inline-block mb-2">Host:</label>
                <input id="@{_host}" class="paAudioBase-text-area" type="text"
                title="API host url" placeholder="Your api host" value="@{host}"/>
        </div>
    
        <!-- Path  -->
        <div class="w-full mb-2">
            <label for="@{_path_}" class="form-label inline-block mb-2">Path:</label>
                <input id="@{_path_}" class="paAudioBase-text-area" type="text"
                title="MediaMTX path" placeholder="Your path" value="@{path}"/>
        </div>

        <!-- source  -->
        <div class="w-full mb-2">
            <label for="@{_source}" class="form-label inline-block mb-2">Source:</label>
                <input id="@{_source}" class="paAudioBase-text-area" type="text"
                title="Media source" placeholder="Your source" value="@{source}"/>
        </div>
        `).replace('%cardHtml%',`

        <div class="w-full">
            <span class="whitespace-normal inline-block max-w-full max-h-[236px] break-words overflow-hidden text-ellipsis">@{description}</span>
        </div>

        `);
    }


    Init() {
        super.Init();
        this.setHeaderColor('#0D6EFD');

        //----------------------Help Modal-----------------------------//
        // Load help from MD
        this._loadHelpMD('controls/MediaMTX.md');
        //----------------------Help Modal-----------------------------//
    }
}