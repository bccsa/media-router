class checkBox extends ui {
    constructor() {
        super();

        this.value = false;
        this.label = '';
        this.color = "#293548";
    }

    get html() {
        return `
        
            <!--    CHECKBOX -->
            <div class="basis-1/4 mr-2 mb-2 flex items-center">
                <div id="@{_container}" class="flex justify-center items-center bg-[#1E293B] text-white  mr-2 px-2.5 py-1 rounded-full">
                    <input id="@{_check}" class="h-4 w-4 mr-2 form-label inline-block" type="checkbox" checked  value="${this.value}"/>  
                    <label id="@{_label}" for="@{_check}" class="form-label inline-block">${this.label}</label>
                </div>
            </div>

        `;
    }

    Init() {
        //Set initial values
        this._check.checked = this.value;
        this._label.innerText = this.label;
        this._container.style.backgroundColor = this.color;

        // Handle property changes
        this.on('value', value => {
            this._check.checked = value;

            this.emit('check', this.value);

        });

        this.on('label', label => {
            this._label.innerText = label;
        });

        // Event subscriptions
        this._check.addEventListener('click', value => {
            this.value = !this.value;
            this.NotifyProperty('value');
        })

    }






}