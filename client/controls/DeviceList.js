class DeviceList extends ui {
    constructor() {
        super();
        this.description = "";
        this.autoStart = false;
        this.autoStartDelay = 500;  // milliseconds
        this._controlsDiv = undefined;
    }
    
    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="drop-shadow-2xl m-2 p-2 w-auto overflow-hidden bg-white rounded-lg text-black border-solid border border-b-[#75C4EB]">

            <details class="rounded group">
                <summary class="list-none flex items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[10] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="grid grid-cols-3 mt-1 mb-1 ml-4 pl-2 w-full h-10">

                            <!-- Name -->
                            <div class="w-1/3">
                                <span class="font-semibold text-xl" title="Audio Input Name">${this.name}</span>

                            </div>

                            <!--  -->
                            <div class="ml-[10.5rem] mt-2">
                                
                            </div>

                            <!-- Container toggle -->
                            <div class="w-1/4 flex flex-col items-end ml-28">
                                <div class="flex w-10 items-center justify-center">
                                    <div class="border-8 border-transparent border-l-black mr-1 mt-1
                                    group-open:rotate-90 transition-transform origin-left
                                    "></div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#DADBDC]"></div>

                <!-- More Info Container  -->
                <div class="p-6 pt-2 w-full h-auto">

                    <div id="${this._uuid}_audioInputControls" class="h-auto w-auto"></div>
                    
                    
                </div>  

            </details> 

        </div>`;

    }

    
    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
        this._controlsDiv = document.getElementById(`${this._uuid}_audioInputControls`);
        

        // //Event subscriptions
        // this._description.addEventListener('change', (e) => {
        //     this.description = this._description.value;
        // });

        // // Handle property changes

        // this.on('description', description => {
        //     this._description.value = description;
        // });
    }
}
    