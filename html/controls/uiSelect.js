// =====================================
// Textbox with label and helptext
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiSelect extends _uiControl {
    constructor(){
        super();
        this.values = ["option1", "option2", "option3", "option4"];
        this._sources.push('controls/js/ThisDoesNotExist.js');
        this._styles.push('controls/css/bootstrap.min.css')
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------

    get html(){
        return `
        <!-- ${this.name} --> 
            <div id="${this._uuid}_main" class="col-lg-3">
                <label> ${this.displayName}  </label>
                <Select  id="${this._uuid}_select" class="form-control">
                    ${this.values.forEach((value) => {
                        `<option value="${this.value}"> ${this.value} </option>`
                    })}
                </Select>
                
            </div>
        `;
    }

    DomLinkup(){
        this._mainDiv = document.getElementById(`${this._uuid}_main`);

        // Element containing child controls
        this._input = document.getElementById(`${this._uuid}_select`);

        // This should be defined if the super AddControl function should be able to add child controls to this control
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
 
    }
}