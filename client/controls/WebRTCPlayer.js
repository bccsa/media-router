class WebRTCPlayer extends ui {
    constructor() {
        super();
        this.url = '';
        this.playerName = '';
        this.img = '';
    }

    get html() {
        return `
        <div class="border-t border-gray-600 rounded-b-md"></div> 

        <!-- Player Name -->
        <div class="w-full mb-2">
            <div class="flex">
                <label for="@{_playerName}" class="form-label inline-block self-end grow">Player Name:</label>
                <button id="@{_btnDelete}" class="h-6 w-6 paAudioBase-btn-delete self-center" type="button" data-bs-dismiss="modal"
                title="Delete device"></button>
            </div>

            <input id="@{_playerName}" class="paAudioBase-text-area" type="text"
            title="WebRTC Player Name" placeholder="WebTRC Player Name" value="@{playerName}"/>
        </div>

        <!-- WebRTC host -->
        <div class="w-full mb-2">
            <label for="@{_url}" class="form-label inline-block">WebRTC WHEP URL:</label>
                <input id="@{_url}" class="paAudioBase-text-area" type="text"
                title="WebRTC WHEP URL" placeholder="Your WebTRC UrL" value="@{url}"/>
        </div>

        <!-- WebRTC Player image -->
        <div class="w-full mb-2">
            <label for="@{_img}" class="form-label inline-block">WebRTC Player icon:</label>
                <input id="@{_img}" class="paAudioBase-text-area" type="text"
                title="WebRTC Player icon" placeholder="Your WebTRC Player icon link" value="@{img}"/>
        </div>
        `
    }


    Init() {
        // Delete control
        this._btnDelete.addEventListener('click', (e) => {
            // Show message box
            this.emit('messageBox',
            {
                buttons: ["Cancel", "Yes"],
                title: `Delete ${this.playerName}?`,
                text: 'Are you sure you want to delete the player?',
                img: 'paAudioBase-modal-img-delete',
                callback: function (data) {
                    if (data == 'Yes') {
                        this._notify({ remove: true });
                        this.SetData({ remove: true });
                    }
                }.bind(this)
            }, 'top');
        });   
    }
}