class WebRTCPlayer extends ui {
    constructor() {
        super();
        this.url = '';
        this.playerName = '';
    }

    get html() {
        return `
        <div class="border-t border-gray-600 rounded-b-md mx-[-1rem] my-2"></div> 

        <!-- Player Name -->
        <div class="w-full mb-2">
            <div class="flex">
                <label for="@{_playerName}" class="form-label inline-block mb-2 w-2/3">Player Name:</label>
                <button id="@{_btnDelete}" class="paAudioBase-btn-delete w-1/3" type="button" data-bs-dismiss="modal"
                title="Delete device"></button>
            </div>

            <input id="@{_playerName}" class="paAudioBase-text-area" type="text"
            title="WebRTC Player Name" placeholder="WebTRC Player Name" value="@{playerName}"/>
        </div>

        <!-- WebRTC host -->
        <div class="w-full mb-2">
            <label for="@{_url}" class="form-label inline-block mb-2">WebRTC Host:</label>
                <input id="@{_url}" class="paAudioBase-text-area" type="text"
                title="WebRTC host name / ip address" placeholder="Your WebTRC Host" value="@{url}"/>
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