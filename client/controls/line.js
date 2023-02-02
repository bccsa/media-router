class line extends ui {
    constructor() {
        super();
        this.top = 0;
        this.left = 0;
        this.bottom = 0;
        this.right = 0;
    }

    get html() {
        return `
        <div id="@{_line}" class="absolute bg-black w-1 h-1">
        </div>`
    }

    Init() {
        this._drawLine();

        // Event Handling
        this.on('top', this._drawLine);
        this.on('left', this._drawLine);
        this.on('bottom', this._drawLine);
        this.on('right', this._drawLine);
    }

    _drawLine() {
        const length = Math.sqrt((this.right - this.left) * (this.right - this.left) + (this.bottom - this.top) * (this.bottom - this.top));
        this._line.style.width = length + "px";

        const angleR = Math.atan2(this.bottom - this.top, this.right - this.left);
        const angle = angleR * 180 / Math.PI;
        this._line.style.transform = `rotate(${angle}deg)`;

        var offsetX = -length / 2 * (1 - Math.cos(angleR));
        var offsetY = length / 2 * Math.sin(angleR);

        this._line.style.top = (this.top + offsetY) + "px";
        this._line.style.left = (this.left + offsetX) + "px";
    }
}