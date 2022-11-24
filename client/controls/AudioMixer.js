class AudioMixer extends ui {
    constructor() {
        super();
//        this._styles.push('AudioMixer.css');
        this.description = "type your description here";
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <div class="m-4 p-4 w-1/2 h-12 bg-[#1E293B] rounded-lg mb-0.5 text-white indent-2.5 align-bottom  border-none border-black">
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