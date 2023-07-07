class Separator extends _routerChildControlBase {
    constructor() {
        super();

    }

    get html() {
        return super.html.replace('%cardHtml%', `
        <div class="w-full">
        <span class="whitespace-normal inline-block max-w-full max-h-[236px] break-words overflow-hidden text-ellipsis">@{description}</span>
        </div>
        `).replace('%modalHtml%','');
    }

    Init() {
        super.Init();
        this.setHeaderColor('#475569');
    }
}