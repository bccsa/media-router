class AudioMixer extends ui {
    constructor() {
        super();
        this._styles.push('AudioMixer.css');
        this.description = "type your description here";
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <div class="AudioMixer">
            <span class="AudioMixer_title">${this.name}</span>
            <input id="${this._uuid}_description" class="AudioMixer_textInput" type="text" value="${this.description}"></input>
        </div>`;
    }

    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
    }

    Update(propertyName) {
        switch (propertyName) {
            case "description":
                this._description.value = this.description;
            default:
                break;
        }
    }
}