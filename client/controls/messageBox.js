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

        let btnHtml = `<button type="button" id="@{_&name&}" data-name="&name&" class="px-6 py-2.5  bg-purple-600 text-white font-medium text-xs mr-2
        leading-tight uppercase rounded shadow-md hover:bg-purple-700 hover:shadow-lg focus:bg-purple-700 focus:shadow-lg
        focus:outline-none focus:ring-0 active:bg-purple-800 active:shadow-lg transition duration-150 ease-in-out">
        &name&</button>`;

        let btns = "";

        this.buttons.forEach(btn => {
            btns += btnHtml.replaceAll('&name&', btn);
        })
        

        return `

        <!-- messageBox modal -->
        <div class="fixed top-0 left-0 w-full h-full outline-none overflow-x-hidden overflow-y-auto z-[1050] bg-[#00000050]"
            id="@{_modal_messageBox}" tabindex="-1" aria-hidden="false">
            <div class="modal-dialog mt-32 transition-opacity duration-300 relative w-auto pointer-events-none z-[1055]">
                <div class="modal-content border-none shadow-lg relative flex flex-col w-full pointer-events-auto bg-white bg-clip-padding rounded-md outline-none text-current">
                    <div class="modal-header flex flex-shrink-0 items-center justify-between p-4 border-b border-gray-200 rounded-t-md">

                        <div class="inline modal-header h-[1.875rem] w-[1.875rem] ${this.img} bg-cover bg-center bg-no-repeat"></div>

                        <h5 class="ml-2 text-xl font-medium leading-normal text-gray-800">${this.title}</h5>

                        <button type="button" id="@{_btn_close}"
                        class="btn-close box-content w-4 h-4 p-1 text-black border-none rounded-none opacity-50 focus:shadow-none
                        focus:outline-none focus:opacity-100 hover:text-black hover:opacity-75 hover:no-underline"
                        aria-label="Close"></button>
                    </div>
                    <div class="modal-body relative p-4">${this.text}</div>
                    <div class="modal-footer flex flex-shrink-0 flex-wrap items-center justify-end p-4 border-t border-gray-200 rounded-b-md">
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

        this._modal_messageBox.addEventListener('click', (e) => {
            // Destroy the control
            m.SetData({remove: true});
        })

        this._btn_close.addEventListener('click', (e) => {
            // Destroy the control
            m.SetData({remove: true});
        })

    }
}
