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
    }

    // -------------------------------------
    // Getters & setters
    // -------------------------------------

    get html(){
        let options = '';
        this.values.forEach((value) => {
            options += `<option value="${value}"> ${value} </option>`
        });

        return `
        <!-- ${this.name} --> 
            <div id="${this._uuid}_main" class="col-lg-3">
                <label> ${this.displayName}  </label>
                <Select  id="${this._uuid}_select" class="form-control">
                    ${options}
                </Select>
                
            </div>
        `;
    }

    Init(){
        this._mainDiv = document.getElementById(`${this._uuid}_main`);

        // Element containing child controls
        this._input = document.getElementById(`${this._uuid}_select`);

        // This should be defined if the super AddControl function should be able to add child controls to this control
        this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
 
    }
}