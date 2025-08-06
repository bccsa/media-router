export function sdpMudgeIceCandidates(sdp: string, candidates: string[]): string {
    // Parse the SDP to find the m= line
    const lines = sdp.split('\n');
    const mLineIndex = lines.findIndex(line => line.startsWith('m='));

    if (mLineIndex === -1) {
        console.error('❌ No media line found in SDP');
        return sdp;
    }

    // Insert each candidate after the m= line
    candidates.forEach(candidate => {
        lines.splice(mLineIndex + 1, 0, `a=${candidate}`);
    });

    return lines.join('\n');
}
