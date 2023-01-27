class messageBox extends ui {
    constructor() {
        super();
        this.buttons = [];
        this.title = "";
        this.text = "";
        this.img = "";
        this.callback = "";
    }

    get html() {

        let btnHtml = `<button type="button" id="@{_&name&}" data-name="&name&" class="message-modal-btn mr-2">
        &name&</button>`;

        let btns = "";

        this.buttons.forEach(btn => {
            btns += btnHtml.replaceAll('&name&', btn);
        })
        

        return `

        <!--    MESSAGE BOX MODAL    -->
        <div id="@{_modalMessageBox}" class="message-modal z-[1050] bg-[#00000050]" tabindex="-1" aria-hidden="false">
            <div class="modal-dialog message-modal-dialog">
                <div class="message-modal-content">

                    <div class="message-modal-header">
                        <div class="message-modal-img ${this.img}"></div>
                        <h5 class="message-modal-heading">${this.title}</h5>
                        <button id="@{_btnClose}" class="message-modal-btn-close"
                        type="button" aria-label="Close"></button>
                    </div>

                    <div class="message-modal-body">${this.text}</div>

                    <div class="message-modal-footer">
                        ${btns}
                    </div>

                </div>
            </div>
        </div>
        `;
    }

    Init() {
        this.buttons.forEach(btn => {
            this['_' + btn].addEventListener('click', btnClicked);
        })

        let m = this;
        function btnClicked(e) {
            // Send this back to messageBox requester via this.callback
            if (typeof m.callback == 'function') {
                m.callback(e.target.dataset.name);
            } else {
                console.log('Callback for messageBox not defined or not a function.')
            }
            
            // Destroy the control
            m.SetData({remove: true});
        }

        this._modalMessageBox.addEventListener('click', (e) => {
            // Destroy the control
            m.SetData({remove: true});
        })

        this._btnClose.addEventListener('click', (e) => {
            // Destroy the control
            m.SetData({remove: true});
        })

    }
}
