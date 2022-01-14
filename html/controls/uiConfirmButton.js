// Implementing Sweet Alert JS here
// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiConfirmButton extends _uiControl {
  constructor() {
    super();
    this.displayName = "The modal";
    this.helpText = "Modal for confirmation";
    this.styleClass = "btn btn-danger";
    this._styles.push("controls/css/bootstrap.min.css"); 
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
          <!-- ${this.name} --> 
            <button type="button" id="${this._uuid}_buttonModal" class="btn btn-primary" data-toggle="modal" data-target="#exampleModal">
            ${this.displayName}
            </button>

 
            <div class="modal fade" id="exampleModal" tabindex="-1" role="dialog" aria-labelledby="exampleModalLabel" aria-hidden="true">
            <div class="modal-dialog" role="document">
                <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="exampleModalLabel">  ${this.displayName} </h5>
                    <button type="button" class="close" data-dismiss="modal" aria-label="Close">
                    <span aria-hidden="true">&times;</span>
                    </button>
                </div>
                <div class="modal-body">
                    ${this.helpText}
                </div>
                <div class="modal-footer">
                    <button type="button" id="${this._uuid}_buttonOk" class="btn btn-secondary" data-dismiss="modal">Close</button>
                    <button type="button" id="${this._uuid}_buttonCancel" class="btn btn-primary">Save changes</button>
                </div>
                </div>
            </div>
            </div>
          `;
  }

  DomLinkup() {
    this._buttonOk = document.getElementById(`${this._uuid}_buttonOk`);
    this._buttonCancel = document.getElementById(`${this._uuid}_buttonCancel`);
    this._buttonModal = document.getElementById(`${this._uuid}_buttonModal`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);

    let o = this;
    this._buttonModal.addEventListener("click", function () {
      console.log("click event is ready");
    });
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._helpText.innerHTML = this.helpText;
        break;
      }
      case "styleClass": {
        this._button.className = this.styleClass;
        break;
      }
    }
  }
}
