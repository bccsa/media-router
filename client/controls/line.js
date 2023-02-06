class line extends ui {
    constructor() {
        super();
        this.top = 0;
        this.left = 0;
        this.bottom = 0;
        this.right = 0;
        this.lineHeight = 2;
        this.arrowHeadHeight = 8;
        this.arrowHeadWidth = 8;
    }

    get html() {
        return `
        <div id="@{_line}" class="absolute bg-blue-600 w-[0.125rem] h-[0.125rem] z-0"></div>

        <div id="@{_arrowHead}" class="w-0 h-0 border-t-[0.25rem] border-t-transparent border-b-[0.25rem] border-b-transparent border-l-[0.5rem] border-sky-900 absolute"></div>
        
          
        `
        
    }

    Init() {
        this._drawLine();

        // Event Handling
        this.on('top', (e) => {
            this._drawLine();
        })

        this.on('left', (e) => {
            this._drawLine();
        })
        this.on('bottom', (e) => {
            this._drawLine();
        })
        this.on('right', (e) => {
            this._drawLine();
        })

        
        // <div class="w-0 h-0 border-t-[0.5rem] border-t-transparent border-b-[0.5rem] border-b-transparent border-l-[0.5rem] border-l-black float-right"></div>
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

        const midY = (this.top + this.bottom - this.arrowHeadHeight + this.lineHeight)/2  ;
        const midX = (this.left + this.right - this.arrowHeadWidth)/2;

        // const midY = (this.top + this.bottom)/2;
        // const midX = (this.left + this.right)/2;

        this._arrowHead.style.transform = `rotate(${angle}deg)`;

        
        this._arrowHead.style.top = (midY) + "px";
        this._arrowHead.style.left = (midX) + "px";
    }
}