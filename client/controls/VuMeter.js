/**
 * VU Meter control
 * @property {String} orientation - "vertical" or "horizontal" orientation
 * @property {Number} level - Level - to be set with SetData()
 */
class VuMeter extends ui {
    constructor() {
        super();
        this.orientation = "vertical";
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
        this.borderRadius = "25px";
        this.boxShadow = "none";
        this.transform = "none";
        this.scale = 1;
        this.numBlocks = 15; // Number of discrete blocks
        this.blockGap = 2;   // Gap between blocks in pixels

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
        if (this.orientation == 'vertical') {
            this.on('level', level => {
                // this._setLevelVertical(level);
            });
        }
        else {
            this.on('level', level => {
                this._setLevelHorizontal(level);
            });
        }

        this.on('scale', scale => {
            this._setSize(scale);
        },{immediate: true})
        

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
            this._setSize(this.scale);
        });
        divResizeObserver.observe(this._div);
    }

    
    _setSize(scale) {
        let r = this._div.getBoundingClientRect();

        this._width = r.width / scale;
        this._height = r.height / scale;
        this._ctx.canvas.width = this._width;
        this._ctx.canvas.height = this._height;
        this._canvas.style.left = this._div.offsetLeft + "px";
        this._canvas.style.top = this._div.offsetTop + "px";

        // reset level to ensure canvas is repainted
        this.level = 0;
    }

    _setLevelHorizontal(levelArr) {
        // Calculate block dimensions
        const blockWidth = (this._width - (this.numBlocks - 1) * this.blockGap) / this.numBlocks;

        for (let ch = 0; ch < levelArr.length; ch++) {
            let p = levelArr[ch]; // level from 0 to 15

            let paintTop = this._height / levelArr.length * ch;
            let paintHeight = this._height / levelArr.length;

            // Clamp value to valid range (0-15)
            let numFilledBlocks = Math.min(Math.max(Math.round(p), 0), this.numBlocks);

            if (!this._prev[ch]) {
                this._prev[ch] = {
                    numFilledBlocks: 0
                };
            }

            // Only redraw if the number of blocks changed
            if (numFilledBlocks !== this._prev[ch].numFilledBlocks) {
                // Clear the entire channel
                this._ctx.clearRect(0, paintTop, this._width, paintHeight);

                // Draw blocks from left to right
                for (let i = 0; i < this.numBlocks; i++) {
                    let blockLeft = i * (blockWidth + this.blockGap);
                    
                    // Determine block color based on position
                    let color;
                    if (i < 10) {
                        color = "green";
                    } else if (i < 13) {
                        color = "orange";
                    } else {
                        color = "red";
                    }

                    // Fill block if it should be lit
                    if (i < numFilledBlocks) {
                        this._ctx.fillStyle = color;
                        this._ctx.fillRect(blockLeft, paintTop + 1, blockWidth, paintHeight - 2);
                    }
                }

                this._prev[ch].numFilledBlocks = numFilledBlocks;
            }
        }
    }
}