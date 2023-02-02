class checkBox extends ui {
    constructor() {
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
            this._drawLines()
        })

    }

    _drawLines() {
        let AudioOutputName = this.label;

        const element1 = this._parent._element1;
        const element2 = this._parent._element2;
        const line = this._parent._line;

        const x1 = element1.offsetLeft + (element1.offsetWidth / 2);
        const y1 = element1.offsetTop + (element1.offsetHeight / 2);
        const x2 = element2.offsetLeft + (element2.offsetWidth / 2);
        const y2 = element2.offsetTop + (element2.offsetHeight / 2);

        const length = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
        line.style.width = length + "px";

        const angleR = Math.atan2(y2 - y1, x2 - x1);
        const angle = angleR * 180 / Math.PI;
        line.style.transform = `rotate(${angle}deg)`;

        var offsetX = -length/2 * (1-Math.cos(angleR));
        var offsetY = length/2 * Math.sin(angleR);

        line.style.top = (y1 + offsetY) + "px";
        line.style.left = (x1 + offsetX) + "px";
    }


}