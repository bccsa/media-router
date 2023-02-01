class tickBox extends ui {
    constructor () {
        super();

        value = false;
        label = 'new tickbox';
        group = '';
    }

    get html() {
        return `
            <label id="@{_label}"/>
            <input id="@{_check} type="checkbox"/>
        `;
    }

    Init() {

        // Update 
        this.on('value', value => {
            this._check.value = value;
        });

        this.on('label', label => {
            this._label.innerHtml = label;
        });

        // Notify

        this._check.addEventListener('click', value => {
            this.emit('check', value);
        })
    }
}