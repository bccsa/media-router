/**
 * VU Meter control
 * @property {String} orientation - "vertical" or "horizontal" orientation
 * @property {Number} level - Level - to be set with SetData()
 */
class VuMeter extends ui {
    constructor() {
        super();
        this.orientation = "vertical";
        this.level = 0;
        this._height = 0;
        this._width = 0;
        this._totalPrev = 0;
        this._top1Prev = 0;
        this._bot1Prev = 0;
        this._top2Prev = 0;
        this._bot2Prev = 0;
        this._top3Prev = 0;
        this._bot3Prev = 0;
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <!--<div style="display: block; width: 200px; height: 200px;">-->
        <div id="${this._uuid}_div" style="display: block; width: 100%; height: 100%; padding: 0px;">
            <canvas id="${this._uuid}_canvas"></canvas>
        </div>
        <!--</div>-->`
    }

    Init() {
        this._div = document.getElementById(`${this._uuid}_div`);
        this._canvas = document.getElementById(`${this._uuid}_canvas`);
        this._canvas.style.position = 'absolute';
        this._ctx = this._canvas.getContext("2d");
        
        // Listen for div size changes
        const divResizeObserver = new ResizeObserver(() => {
            this._width = this._div.clientWidth;
            this._height = this._div.clientHeight;
            this._ctx.canvas.width = this._div.clientWidth;
            this._ctx.canvas.height = this._div.clientHeight;

            // Set initial
            this._setLevelVertical();
        });
        divResizeObserver.observe(this._div); 
    }

    Update(propertyName) {
        switch (propertyName) {
            case "level":
                //this._setLevelVertical();
                //this._setLevelHorizontal();
                break;
            default:
                break;
        }
    }

    _setLevelVertical() {
        // Logarithmic level in 50 steps
        let p = Math.round(20 * Math.log10(this.level) * 50) / 50;

        let height1 = Math.min(Math.max((p + 60), 0), 60 - 20) * this._height / 60;  // Start showing from -60dB. Max height at -20dB (40dB height)
        let height2 = Math.min(Math.max((p + 20), 0), 20 - 9) * this._height / 60;   // Start showing from -20dB. Max height at -9dB (11dB height)
        let height3 = Math.min(Math.max((p + 9), 0), 9 - 0) * this._height / 60;     // Start showing from -9dB. Max height at -0dB (9dB height)

        let bot1 = this._height;
        let top1 = this._height - height1;
        let bot2 = top1;
        let top2 = bot2 - height2;
        let bot3 = top2;
        let top3 = bot3 - height3;

        let total = height1 + height2 + height3;

        // Clear
        if (total < this._totalPrev) {
            this._ctx.clearRect(0, this._top3Prev, this._width, top3 - this._top3Prev);
        }
        // Draw
        else if (total > this._totalPrev) {
            if (top1 < this._top1Prev) {
                this._ctx.fillStyle = "green";
                this._ctx.fillRect(0, top1, this._width, this._top1Prev - top1 + 1);
            }
            if (top2 < this._top2Prev && top2 < bot2) {
                let bot = this._top2Prev;
                if (this._top2Prev > bot2) bot = bot2;
                this._ctx.fillStyle = "orange";
                this._ctx.fillRect(0, top2, this._width, bot - top2 + 1);
            }
            if (top3 < this._top3Prev && top3 < bot3) {
                let bot = this._top3Prev;
                if (this._top3Prev > bot3) bot = bot3;
                this._ctx.fillStyle = "red";
                this._ctx.fillRect(0, top3, this._width, bot - top3 + 1);
            }
        }

        this._top1Prev = top1;
        this._bot1Prev = bot1;
        this._top2Prev = top2;
        this._bot2Prev = bot2;
        this._top3Prev = top3;
        this._bot3Prev = bot3;
        this._totalPrev = total;
    }

    _setLevelHorizontal() {
        // Logarithmic level in 50 steps
        let p = Math.round(20 * Math.log10(this.level) * 50) / 50;

        let width1 = Math.min(Math.max((p + 60), 0), 60 - 20) * this._width / 60;  // Start showing from -60dB. Max width at -20dB (40dB width)
        let width2 = Math.min(Math.max((p + 20), 0), 20 - 9) * this._width / 60;   // Start showing from -20dB. Max width at -9dB (11dB width)
        let width3 = Math.min(Math.max((p + 9), 0), 9 - 0) * this._width / 60;     // Start showing from -9dB. Max width at -0dB (9dB width)

        let bot1 = this._width;
        let top1 = this._width - width1;
        let bot2 = top1;
        let top2 = bot2 - width2;
        let bot3 = top2;
        let top3 = bot3 - width3;

        let total = width1 + width2 + width3;

        // Clear
        if (total < this._totalPrev) {
            this._ctx.clearRect(this._top3Prev, 0, top3 - this._top3Prev, this._width);
        }
        // Draw
        else if (total > this._totalPrev) {
            if (top1 < this._top1Prev) {
                this._ctx.fillStyle = "green";
                this._ctx.fillRect(top1, 0, this._top1Prev - top1 + 1, this._width);
            }
            if (top2 < this._top2Prev && top2 < bot2) {
                let bot = this._top2Prev;
                if (this._top2Prev > bot2) bot = bot2;
                this._ctx.fillStyle = "orange";
                this._ctx.fillRect(top2, 0, bot - top2 + 1, this._width);
            }
            if (top3 < this._top3Prev && top3 < bot3) {
                let bot = this._top3Prev;
                if (this._top3Prev > bot3) bot = bot3;
                this._ctx.fillStyle = "red";
                this._ctx.fillRect(top3, 0, bot - top3 + 1, this._width);
            }
        }

        this._top1Prev = top1;
        this._bot1Prev = bot1;
        this._top2Prev = top2;
        this._bot2Prev = bot2;
        this._top3Prev = top3;
        this._bot3Prev = bot3;
        this._totalPrev = total;
    }
}