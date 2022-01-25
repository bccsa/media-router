// =====================================
// uiList controls
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiList extends _uiControl {
  constructor() {
    super();
    this.name = "";
    this.displayName = "";
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiList.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
            <!-- ${this.name} -->
            <li class="uiList" id="${this._uuid}_${this.name}"> <img src="../assets/img/${this.displayName}">  </li>
        `;
  }

  Init() {
    this._list = document.getElementById(`${this._uuid}_${this.name}`);
  }
}
