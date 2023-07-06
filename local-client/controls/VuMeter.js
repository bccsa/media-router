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
        this._prev = {};    // Previous values object
        this.height = "100%";
        this.width = "100%";
        this.background = "none";
        this.margin = 0;
        this.marginTop = 0;
        this.marginBottom = 0;
        this.marginLeft = 0;
        this.marginRight = 0;
        this.borderStyle = "none";
        this.borderWidth = 0;
        this.borderColor = "none";
        this.borderRadius = "10px";
        this.boxShadow = "none";
        this.transform = "none";

        this.title = "Vu Meter";
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <div id="@{_div}" style="display: block;" title="@{title}">
            <canvas id="@{_canvas}" class="paAudioBase_volume_slit_canvas" style="border-radius: ${this.borderRadius}; "></canvas>    
        </div>`
    }

    Init() {
        this._canvas.style.position = 'sticky';
        this._ctx = this._canvas.getContext("2d");

        if (typeof this.height == 'number') {
            this._div.style.height = this.height + "px";
        } else {
            this._div.style.height = this.height;
        }

        if (typeof this.width == 'number') {
            this._div.style.width = this.width + "px";
        } else {
            this._div.style.width = this.width;
        }

        this._div.style.background = this.background;

        if (typeof this.margin == 'number') {
            this._div.style.margin = this.margin + "px";
        } else {
            this._div.style.margin = this.margin;
        }

        if (typeof this.marginTop == 'number') {
            this._div.style.marginTop = this.marginTop + "px";
        } else {
            this._div.style.marginTop = this.marginTop;
        }

        if (typeof this.marginBottom == 'number') {
            this._div.style.marginBottom = this.marginBottom + "px";
        } else {
            this._div.style.marginBottom = this.marginBottom;
        }

        if (typeof this.marginRight == 'number') {
            this._div.style.marginRight = this.marginRight + "px";
        } else {
            this._div.style.marginRight = this.marginRight;
        }

        if (typeof this.marginLeft == 'number') {
            this._div.style.marginLeft = this.marginLeft + "px";
        } else {
            this._div.style.marginLeft = this.marginLeft;
        }

        this._div.style.borderStyle = this.borderStyle;

        if (typeof this.borderWidth == 'number') {
            this._div.style.borderWidth = this.borderWidth + "px";
        } else {
            this._div.style.borderWidth = this.borderWidth;
        }

        this._div.style.borderColor = this.borderColor;

        if (typeof this.borderRadius == 'number') {
            this._div.style.borderRadius = this.borderRadius + "px";
        } else {
            this._div.style.borderRadius = this.borderRadius;
        }

        this._div.style.boxShadow = this.boxShadow;
        // this._div.style.transform = this.transform;

        this._div.title = this.title;



        // Handle property changes
        this.on('level', level => {
            this._setLevel(level);
        });

        this._setSize();

        this.on('width', width => {
            if (typeof width == 'number') {
                this._div.style.width = width + "px";
            } else {
                this._div.style.width = width;
            }
        });

        this.on('height', height => {
            if (typeof height == 'number') {
                this._div.style.height = height + "px";
            } else {
                this._div.style.height = height;
            }
        });

        this.on('background', background => {
            this._div.style.background = background;
        });

        this.on('margin', margin => {
            if (typeof margin == 'number') {
                this._div.style.margin = margin + "px";
            } else {
                this._div.style.margin = margin;
            }
        });

        this.on('marginTop', marginTop => {
            if (typeof marginTop == 'number') {
                this._div.style.marginTop = marginTop + "px";
            } else {
                this._div.style.marginTop = marginTop;
            }
        });

        this.on('marginBottom', marginBottom => {
            if (typeof marginBottom == 'number') {
                this._div.style.marginBottom = marginBottom + "px";
            } else {
                this._div.style.marginBottom = marginBottom;
            }
        });

        this.on('marginRight', marginRight => {
            if (typeof marginRight == 'number') {
                this._div.style.marginRight = marginRight + "px";
            } else {
                this._div.style.marginRight = marginRight;
            }
        });

        this.on('marginLeft', marginLeft => {
            if (typeof marginLeft == 'number') {
                this._div.style.marginLeft = marginLeft + "px";
            } else {
                this._div.style.marginLeft = marginLeft;
            }
        });

        this.on('borderStyle', borderStyle => {
            this._div.style.borderStyle = borderStyle;
        });

        this.on('borderWidth', borderWidth => {
            if (typeof borderWidth == 'number') {
                this._div.style.borderWidth = borderWidth + "px";
            } else {
                this._div.style.borderWidth = borderWidth;
            }
        });

        this.on('borderColor', borderColor => {
            this._div.style.borderColor = borderColor;
        });

        this.on('borderRadius', borderRadius => {
            if (typeof borderRadius == 'number') {
                this._div.style.borderRadius = borderRadius + "px";
                this._canvas.style.borderRadius = borderRadius + "px";
            } else {
                this._div.style.borderRadius = borderRadius;
                this._canvas.style.borderRadius = borderRadius;
            }
        });


        this.on('boxShadow', boxShadow => {
            this._div.style.boxShadow = boxShadow;
        });

        this.on('transform', transform => {
            this._div.style.transform = transform;
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
        this._ctx.canvas.width = this._width;
        this._ctx.canvas.height = this._height;
        this._canvas.style.left = this._div.offsetLeft + "px";
        this._canvas.style.top = this._div.offsetTop + "px";

        // reset level to ensure canvas is repainted
        this.level = 0;
    }

    _setLevel(levelArr) {
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
                this._ctx.clearRect(paintLeft, this._prev[ch].top3 -1, paintWidth + 1, top3 - this._prev[ch].top3, paintWidth);
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