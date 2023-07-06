class Separator extends _routerChildControlBase {
    constructor() {
        super();
    }

    get html() {
        return super.html.replace('%cardHtml%', `
        <span>@{description}</span>
        `).replace('%modalHtml%','');
    }

    Init() {
        super.Init();
        this.setHeaderColor('#475569');
    }
}