/**
 * This class should only be used as a super class for router child controls.
 * Additional modal HTML content should be added through super.html.replace('%modalHtml%','Your additional HTML');
 * Additional control card HTML content should be added through super.html.replace('%cardHtml%','Your additional HTML');
 * Also run super.Init() in the overridden Init() function.
 */
class managerPanel extends ui {
    constructor() {
        super();
        this.managerUrl = "http://localhost:3000";
        this.username = "New manager";
        this.password = "manager";
        this.selected = false;        // show control on local client
        this.rbSelect = "";
        this.displayOrder = 0;          // Sort order on local client

        // {
        //     "default": {
        //         "controlType": "managerPanel",
        //         "displayName": "Local manager",
        //         "managerUrl": "http://localhost:3000",
        //         "username": "testRouter1",
        //         "password": "testPass",
        //         "selected": true
        //     }
        // }
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_mainCard}" class="managerPanel-main-card">
            <!--    TOP HEADING CONTAINER    -->
            <div id="@{_heading}" class="managerPanel-card-heading">
        
                <!--    NAME     -->
                <div class="col-span-2">
                    <div class="managerPanel-card-name">@{username}</div>
                </div>
        
                <!--    SETTINGS BUTTON     -->
                <button id="@{_btnDelete}" class="managerPanel-btn-delete" type="button" title="Delete"></button>

            </div>
        
            <div id="@{_cardBody}" class="managerPanel-card-body">
                <!-- CARD HTML added by extended controls  -->
                    
                    <!--    USERNAME      -->
                    <div class="w-full mb-1 mr-4 mt-2">
                        <div class="mr-4 w-full">
                            <label for="@{_username}" class="mb-2">Username: </label>
                            <input id="@{_username}" class="managerPanel-text-area" type="text"
                                placeholder="Your username" title="Enter a username" value="@{username}" />
                        </div>
                    </div>

                    <!--    PASSWORD      -->
                    <div class="w-full mb-1 mr-4 mt-4">
                        <div class="mr-4 w-full">
                            <label for="@{_password}" class="mb-2">Password: </label>
                            <input id="@{_password}" class="managerPanel-text-area" type="text" 
                                placeholder="Your password" title="Enter a password" value="@{password}" />
                        </div>
                    </div>
    
                    <!--    MANAGER URL      -->
                    <div class="w-full mb-1 mr-4 mt-4">
                        <div class="mr-4 w-full">
                            <label for="@{_managerUrl}" class="mb-2">Manager URL: </label>
                            <input id="@{_managerUrl}" class="managerPanel-text-area" type="text"
                                placeholder="Manager URL" title="Enter a manager URL" value="@{managerUrl}" />
                        </div>
                    </div>


                    <!--    Selected      -->
                            <div class="w-full mr-2 mt-4 flex">
                                <input id="@{_selected}" class="mr-2 mt-1 h-4 w-4" type="radio" name=""
                                    checked="@{selected}"/>
                                <label for="@{_selected}" class=""
                                    title="">Selected</label>
                            </div>
            </div>
        </div>

        
        `;
    }

    Init() {
        
        // Handle property changes
        this.on('selected', selected => {
            if (selected)
            {
                this._mainCard.style.border = "medium solid #DB5461";
                this._heading.style.backgroundColor = "#DB5461";
                
                // console.log(this.username + " " + this.selected);

                // Radio buttons do not trigger on de-selection as per normal browser operation.
                // We therefore need to manually reset the selected status on all other controls.
                Object.values(this._parent._controls).filter(c => c.name != this.name).forEach(control => {
                    control.selected = false;
                });
            }
            else
            {
                this._mainCard.style.border = "thin outset #6b7280";
                this._heading.style.backgroundColor = "#6b7280";
                
                // console.log(this.username + " " + this.selected);
            }
        }, { immediate: true });

        // Delete control
        this._btnDelete.addEventListener('click', (e) => {
            
            let text = "You are deleting the manager panel!";
            if (confirm(text) == true) {
                this._notify({ remove: true });
                this.Set({ remove: true });
            }
        });
    }
}