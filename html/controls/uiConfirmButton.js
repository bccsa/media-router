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
    this.styleClass = "btn btn-primary";
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/modal.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
          <!-- ${this.name} -->
           
          <button class="${this.styleClass}" id="${this._uuid}_buttonModal" > ${this.displayName} </button>

          <div id="${this._uuid}_confirmBox" class="modal">
            <div class="modal-content">
                <button 
                type="button" 
                id="${this._uuid}_buttonOk" 
                class="btn btn-success m-1">
                  Confirm
              </button>

              <button 
                type="button" 
                id="${this._uuid}_buttonCancel" 
                class="btn btn-danger m-1">
                  Cancel
              </button> 
            </div>
          </div>     
      `;
  }

  DomLinkup() {
    this._buttonOk = document.getElementById(`${this._uuid}_buttonOk`);
    this._buttonCancel = document.getElementById(`${this._uuid}_buttonCancel`);
    this._buttonModal = document.getElementById(`${this._uuid}_buttonModal`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);
    this._confirmBox = document.getElementById(`${this._uuid}_confirmBox`);

    let o = this;
    this._buttonModal.addEventListener("click", function () {
      o._confirmBox.style.display = "block";
    });

    this._buttonCancel.addEventListener("click", function () {
      o._confirmBox.style.display = "none";
    });

    // window.addEventListener("click", function (event) {
    //   if (event == o._confirmBox) {
    //     o._confirmBox.style.display = "none";
    //   }
    // });
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
