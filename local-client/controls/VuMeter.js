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
        this.numBlocks = 15; // Number of discrete blocks
        this.blockGap = 2;   // Gap between blocks in pixels
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

        // Calculate block dimensions
        const blockHeight = (this._height - (this.numBlocks - 1) * this.blockGap) / this.numBlocks;

        for (let ch = 0; ch < levelArr.length; ch++) {
            let p = levelArr[ch]; // level in dB

            let paintLeft = this._width / levelArr.length * ch;
            let paintWidth = this._width / levelArr.length;

            // Convert dB to number of blocks (0-15)
            // Range from -60dB (0 blocks) to 0dB (15 blocks)
            let normalizedLevel = Math.min(Math.max((p + 60) / 60, 0), 1);
            let numFilledBlocks = Math.round(normalizedLevel * this.numBlocks);

            if (!this._prev[ch]) {
                this._prev[ch] = {
                    numFilledBlocks: 0
                };
            }

            // Only redraw if the number of blocks changed
            if (numFilledBlocks !== this._prev[ch].numFilledBlocks) {
                // Clear the entire channel
                this._ctx.clearRect(paintLeft, 0, paintWidth, this._height);

                // Draw blocks from bottom to top
                for (let i = 0; i < this.numBlocks; i++) {
                    let blockIndex = this.numBlocks - 1 - i; // Start from bottom
                    let blockTop = i * (blockHeight + this.blockGap);
                    
                    // Determine block color based on position
                    let color;
                    if (blockIndex < 10) {
                        color = "green";
                    } else if (blockIndex < 13) {
                        color = "orange";
                    } else {
                        color = "red";
                    }

                    // Fill block if it should be lit
                    if (blockIndex < numFilledBlocks) {
                        this._ctx.fillStyle = color;
                        this._ctx.fillRect(paintLeft + 1, blockTop, paintWidth - 2, blockHeight);
                    }
                }

                this._prev[ch].numFilledBlocks = numFilledBlocks;
            }
        }
    }
}