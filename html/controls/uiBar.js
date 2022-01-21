// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiBar extends _uiControl {
  constructor() {
    super();

    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiBar.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
                <!-- ${this.name} --> 
                     
                         <div id="${this._uuid}_bar" class="uiBar">
                            <ul>
                                <li id="${this._uuid}_list1"> <img src="../assets/img/list.png"</li>
                                <li id="${this._uuid}_list2"> <img src="../assets/img/settings.png"</li>
                            </ul>
                         </div> 
                `;
  }

  DomLinkup() {
    this._Bar = document.getElementById(`${this._uuid}_Bar`);
    this._list1 = document.getElementById(`${this._uuid}_list1`);
    this._list2 = document.getElementById(`${this._uuid}_list2`);

    let o = this;
    this._list1.addEventListener("click", function () {
      console.log("first");
    });

    this._list2.addEventListener("click", function () {
      console.log("first");
    });
    //  this._terminal = document.getElementById(`${this._uuid}_terminal`);

    // setInterval(() => {
    //   this._eventLog.innerHTML = this.displayName;
    // }, 3000);
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "logText": {
        this._eventLog.innerHTML += this.logText;
        break;
      }
    }
  }
}
