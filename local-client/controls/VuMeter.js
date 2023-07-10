/**
 * VU Meter control
 * @property {Number} level - Level - to be set with SetData()
 */
class VuMeter extends ui {
    constructor() {
        super();
        this.level = [];    // Array with percentage values per channel
        this._height = 0;
        this._width = 0;
        this._adjustSize = false;
        this._prev = {};    // Previous values object
        this.borderRadius = "10px";
        this.title = "Vu Meter";
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <div id="@{_div}" style="display: block;" title="@{title}">
            <canvas id="@{_canvas}" style="border-radius: ${this.borderRadius}; "></canvas>    
        </div>`
    }

    Init() {
        this._canvas.style.position = 'sticky';
        this._ctx = this._canvas.getContext("2d");

        if (typeof this.borderRadius == 'number') {
            this._div.style.borderRadius = this.borderRadius + "px";
        } else {
            this._div.style.borderRadius = this.borderRadius;
        }

        this._div.title = this.title;

        // Handle property changes
        this.on('level', level => {
            this._setLevel(level);
        });

        this._setSize();

        this.on('borderRadius', borderRadius => {
            if (typeof borderRadius == 'number') {
                this._div.style.borderRadius = borderRadius + "px";
                this._canvas.style.borderRadius = borderRadius + "px";
            } else {
                this._div.style.borderRadius = borderRadius;
                this._canvas.style.borderRadius = borderRadius;
            }
        });

        // Listen for div size changes
        const divResizeObserver = new ResizeObserver(() => {
            this._setSize();
        });
        divResizeObserver.observe(this._div);
    }

    _setSize() {
        let r = this._div.getBoundingClientRect();

        this._width = r.width;
        this._height = r.height;
        
        if (this._height >= 100) {
            this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

            this._canvas.style.left = this._div.offsetLeft + "px";
            this._canvas.style.top = this._div.offsetTop + "px";
            this._ctx.canvas.width = this._width;
            this._ctx.canvas.height = this._height - 16;

            // reset level to ensure canvas is repainted
            this.level = 0;
            this._adjustSize = false;

            // Rest slider button position accordingly
            this._parent._calcSliderRange();
            this._parent._setVolume();
        }
    }

    _setLevel(levelArr) {
        if (!this._adjustSize) {
            this._ctx.canvas.height += 16;
            this._adjustSize = true
        }

        for (let ch = 0; ch < levelArr.length; ch++) {
            let p = levelArr[ch]; // level in dB

            // Logarithmic level in 50 steps
            // let p = Math.round(20 * Math.log10(level) * 50) / 50;

            let paintLeft = this._width / levelArr.length * ch;
            let paintWidth = this._width / levelArr.length + 1;

            let bar1 = Math.min(Math.max((p + 60), 0), 60 - 20) * this._height / 60;  // Start showing from -60dB. Max width at -20dB (40dB width)
            let bar2 = Math.min(Math.max((p + 20), 0), 20 - 9) * this._height / 60;   // Start showing from -20dB. Max width at -9dB (11dB width)
            let bar3 = Math.min(Math.max((p + 9), 0), 9 - 0) * this._height / 60;     // Start showing from -9dB. Max width at -0dB (9dB width)

            if (!this._prev[ch]) {
                this._prev[ch] = {
                    bot1: 0,
                    bot2: 0,
                    bot3: 0,
                    top1: 0,
                    top2: 0,
                    top3: 0,
                    total: 0
                };
            }

            let bot1 = this._height;
            let top1 = this._height - bar1;
            let bot2 = top1;
            let top2 = bot2 - bar2;
            let bot3 = top2;
            let top3 = bot3 - bar3;
            let total = bar1 + bar2 + bar3;

            // Clear
            if (p <= -60) {
                this._ctx.clearRect(paintLeft, 0, this._height, paintWidth);
            } else if (total < this._prev[ch].total) {
                this._ctx.clearRect(paintLeft, this._prev[ch].top3 - 1, paintWidth + 1, top3 - this._prev[ch].top3, paintWidth);
            }
            // Draw
            else if (total > this._prev[ch].total) {
                if (top1 < this._prev[ch].top1) {
                    this._ctx.fillStyle = "green";
                    this._ctx.fillRect(paintLeft, top1, paintWidth, this._prev[ch].top1 - top1 + 1);
                }
                if (top2 < this._prev[ch].top2 && top2 < bot2) {
                    let bot = this._prev[ch].top2;
                    if (this._prev[ch].top2 > bot2) bot = bot2;
                    this._ctx.fillStyle = "orange";
                    this._ctx.fillRect(paintLeft, top2, paintWidth, bot - top2 + 1);
                }
                if (top3 < this._prev[ch].top3 && top3 < bot3) {
                    let bot = this._prev[ch].top3;
                    if (this._prev[ch].top3 > bot3) bot = bot3;
                    this._ctx.fillStyle = "red";
                    this._ctx.fillRect(paintLeft, top3, paintWidth, bot - top3 + 1);
                }
            }

            this._prev[ch].top1 = top1;
            this._prev[ch].bot1 = bot1;
            this._prev[ch].top2 = top2;
            this._prev[ch].bot2 = bot2;
            this._prev[ch].top3 = top3;
            this._prev[ch].bot3 = bot3;
            this._prev[ch].total = total;
        }

    }
}