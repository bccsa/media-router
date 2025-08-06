export function sdpMudgeAudioRedEnc(sdp: string): string {
    // Parse the SDP to find the m= line
    const lines = sdp.split('\n');
    const mLineIndex = lines.findIndex(line => line.startsWith('m='));
    if (mLineIndex === -1) {
        console.error('❌ No media line found in SDP');
        return sdp;
    }

    // Add the RED encoder pt in the m= line
    const mLine = lines[mLineIndex];
    lines[mLineIndex] = mLine.replace('111 63', '63 111');

    // Find the a=rtpmap line for pt 63 (RED) and add /2 if not present
    // const rtpMapIndex = lines.findIndex(line => line.startsWith('a=rtpmap:63'));
    // if (rtpMapIndex === -1) {
    //     console.error('❌ No rtpmap line for pt 63 found in SDP');
    //     return sdp;
    // }
    // const rtpMapLine = lines[rtpMapIndex];
    // if (!rtpMapLine.includes('/2')) {
    //     lines[rtpMapIndex] = rtpMapLine.replace('red/48000', 'red/48000/2');
    // }

    // Add an a=fmtp line for pt 63 if it doesn't exist, with references to pt 111 for each distance level
    const distance = 1; // Set the distance for RED encoder

    // if (distance > 0) {
    //     let distanceLevels = '111';
    //     for (let i = 1; i <= distance; i++) {
    //         if (distanceLevels !== '') distanceLevels += '/';
    //         distanceLevels += `111`;
    //     }
    //     const fmtpLine = `a=fmtp:63 ${distanceLevels}`;

    //     // Insert the fmtp line after the a=rtpmap:63 line
    //     lines.splice(rtpMapIndex + 1, 0, fmtpLine);
    // }

    // Add the RED encoder sdp lines
    // const redRtpMap = 'a=rtpmap:63 red/48000/2';
    // const redFmtp = 'a=fmtp:63 111/111';

    // Insert the RED encoder lines after the a=fmpt:111 line
    // const fmtpIndex = lines.findIndex(line => line.startsWith('a=fmtp:111'));
    // if (fmtpIndex === -1) {
    //     console.error('❌ No fmtp line for pt 111 found in SDP');
    //     return sdp;
    // }
    // lines.splice(fmtpIndex + 1, 0, redRtpMap);
    // lines.splice(fmtpIndex + 2, 0, redFmtp);

    return lines.join('\n');
}
