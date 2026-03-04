module.exports = {
    html: () => {
        return `
        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div>

        <!------------------------------ Capture Settings ------------------------------>

        <div class="w-full items-center justify-items-center justify-center mb-2">
            <div class="text-center align-top font-semibold text-base">Capture Settings</div>
        </div>

        <div class="w-full mb-4 flex ">
            <!-- Video Device -->
            <div class="w-full flex flex-col">
                <label for="@{_video_device}" class="form-label inline-block mb-2">Video Device:</label>
                <select id="@{_video_device}" title="Video device" value="@{video_device}"
                class="paAudioBase-select" type="text"></select>
            </div>
        </div>

        <div class="w-full mb-4 flex ">
            <!-- Capture Format -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_capture_format}" class="form-label inline-block mb-2">Capture Format:</label>
                <select id="@{_capture_format}" title="Video input format" value="@{capture_format}"
                class="paAudioBase-select" type="text">
                    <option value="raw">raw</option>
                    <option value="mjpeg">mjpeg</option>
                </select>
            </div>

            <!-- Deinterlace -->
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_deinterlace}" class=""
                    title="Enable or disable deinterlacing">Enable Deinterlacing</label>
                <input id="@{_deinterlace}" class="mr-2 mt-1 h-4 w-4" type="checkbox" checked="@{deinterlace}" />
            </div>
        </div>

        <div class="border-t border-gray-200 rounded-b-md mx-[-1rem] my-2"></div>
        `;
    },
};
