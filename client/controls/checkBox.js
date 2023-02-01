class checkBox extends ui {
    constructor () {
        super();

        this.value = false;
        this.label = '';
    }

    get html() {
        return `
        
            <!--    CHECKBOX    --> 
            <div class="w-1/2 mr-2 mb-2 flex items-center">
                <input id="@{_check}" class="mb-2 mr-2 mt-1 h-6 w-6" type="checkbox" checked  value="${this.value}"/>  
                <label id="@{_label}" for="@{_check}" class="mb-2 mr-2 mt-1">${this.label}</label>
            </div>

        `;
    }

    Init() {
        //Set initial values
        this._check.checked = this.value;
        this._label.innerHtml = this.label;

        // Handle property changes
        this.on('value', value => {
            this._check.checked = value;
        });

        this.on('label', label => {
            this._label.innerHtml = label;
        });

        // Event subscriptions
        this._check.addEventListener('click', value => {
            this.value = !this.value;
            this.NotifyProperty('value');
        })
    }
}