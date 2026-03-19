class Separator extends ui {
    constructor() {
        super();
        this.displayName ='test';
        this.displayOrder = 0;
        this.showControl = true;        // show control on local client
    }

    get html() {
        return `
        <div class="separator_background">
            <table>

                <tr><td class="separator_label">
                    <div><span>@{displayName}</span></div>
                </td></tr>


            </table>
        </div>`;
    }

    Init() {
        
    }
}
