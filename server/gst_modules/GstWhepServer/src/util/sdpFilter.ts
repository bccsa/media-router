// /**
//  * SDP Filter Utility
//  * Filters SDP content to only include specific parameters
//  */

// export interface FilteredSdpParams {
//   // Session-level attributes
//   version?: string;
//   origin?: string;
//   sessionName?: string;
//   timing?: string;
//   bundleGroup?: string;
//   extmapAllowMixed?: boolean;
//   msidSemantic?: string;

//   // Media-level attributes for audio
//   mediaType?: string;
//   connectionInfo?: string;
//   rtcp?: string;
//   iceUfrag?: string;
//   icePwd?: string;
//   iceOptions?: string;
//   fingerprint?: string;
//   setup?: string;
//   mid?: string;
//   extmaps?: string[];
//   direction?: string;
//   rtcpMux?: boolean;
//   rtcpRsize?: boolean;
//   rtpmaps?: string[];
//   rtcpFb?: string[];
//   fmtp?: string[];
// }

/**
 * Filters an SDP string to create an audio-only, receive-only stream
 * @param sdp - The input SDP string
 * @returns Filtered SDP string containing only audio receive-only parameters
 */
export function filterSdp(sdp: string): string {
  const lines = sdp.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  const filteredLines: string[] = [];

  // Extract dynamic values from input SDP
  let originLine = '';
  let iceUfragLine = '';
  let icePwdLine = '';
  let fingerprintLine = '';

  for (const line of lines) {
    if (line.startsWith('o=')) {
      originLine = line;
    } else if (line.startsWith('a=ice-ufrag:')) {
      iceUfragLine = line;
    } else if (line.startsWith('a=ice-pwd:')) {
      icePwdLine = line;
    } else if (line.startsWith('a=fingerprint:')) {
      fingerprintLine = line;
    }
  }

  // Add required session-level attributes
  filteredLines.push('v=0');
  if (originLine) {
    filteredLines.push(originLine);
  }
  filteredLines.push('s=-');
  filteredLines.push('t=0 0');
  filteredLines.push('a=group:BUNDLE 0');
  filteredLines.push('a=extmap-allow-mixed');
  filteredLines.push('a=msid-semantic: WMS');

  // Add audio-only media description (receive-only)
  filteredLines.push('m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126');
  filteredLines.push('c=IN IP4 0.0.0.0');
  filteredLines.push('a=rtcp:9 IN IP4 0.0.0.0');
  
  // Add ICE parameters
  if (iceUfragLine) {
    filteredLines.push(iceUfragLine);
  }
  if (icePwdLine) {
    filteredLines.push(icePwdLine);
  }
  filteredLines.push('a=ice-options:trickle');
  
  // Add security parameters
  if (fingerprintLine) {
    filteredLines.push(fingerprintLine);
  }
  filteredLines.push('a=setup:actpass');
  
  // Add media-level attributes
  filteredLines.push('a=mid:0');
  filteredLines.push('a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level');
  filteredLines.push('a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time');
  filteredLines.push('a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01');
  filteredLines.push('a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid');
  
  // Set direction to receive-only
  filteredLines.push('a=recvonly');
  
  // Add RTP/RTCP attributes
  filteredLines.push('a=rtcp-mux');
  filteredLines.push('a=rtcp-rsize');
  
  // Add audio codec parameters (Opus and RED)
  filteredLines.push('a=rtpmap:111 opus/48000/2');
  filteredLines.push('a=rtcp-fb:111 transport-cc');
  filteredLines.push('a=fmtp:111 minptime=10;useinbandfec=1');
  filteredLines.push('a=rtpmap:63 red/48000/2');
  filteredLines.push('a=fmtp:63 111/111');

  return filteredLines.join('\n') + '\n';
}

// /**
//  * Creates a filtered SDP with specific audio parameters matching the provided example
//  * @param inputSdp - The input SDP string
//  * @returns Filtered SDP string with only audio parameters from the example
//  */
// export function filterToExampleSdp(inputSdp: string): string {
//   const lines = inputSdp.split('\n').map(line => line.trim()).filter(line => line.length > 0);
//   const filteredLines: string[] = [];

//   // Exact parameters from the example
//   const requiredSessionLines = [
//     'v=0',
//     's=-',
//     't=0 0',
//     'a=group:BUNDLE 0',
//     'a=extmap-allow-mixed',
//     'a=msid-semantic: WMS'
//   ];

//   const requiredMediaAttributes = new Set([
//     'c=IN IP4 0.0.0.0',
//     'a=rtcp:9 IN IP4 0.0.0.0',
//     'a=ice-options:trickle',
//     'a=setup:actpass',
//     'a=mid:0',
//     'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
//     'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
//     'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
//     'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid',
//     'a=recvonly',
//     'a=rtcp-mux',
//     'a=rtcp-rsize',
//     'a=rtpmap:111 opus/48000/2',
//     'a=rtcp-fb:111 transport-cc',
//     'a=fmtp:111 minptime=10;useinbandfec=1',
//     'a=rtpmap:63 red/48000/2',
//     'a=fmtp:63 111/111'
//   ]);

//   let inMediaSection = false;
//   let originLine = '';
//   let mediaLine = '';
//   let iceUfragLine = '';
//   let icePwdLine = '';
//   let fingerprintLine = '';

//   // Extract dynamic values from input SDP
//   for (const line of lines) {
//     if (line.startsWith('o=')) {
//       originLine = line;
//     } else if (line.startsWith('m=audio')) {
//       mediaLine = line;
//     } else if (line.startsWith('a=ice-ufrag:')) {
//       iceUfragLine = line;
//     } else if (line.startsWith('a=ice-pwd:')) {
//       icePwdLine = line;
//     } else if (line.startsWith('a=fingerprint:')) {
//       fingerprintLine = line;
//     }
//   }

//   // Add required session-level lines
//   filteredLines.push('v=0');
//   if (originLine) {
//     filteredLines.push(originLine);
//   }
//   filteredLines.push('s=-');
//   filteredLines.push('t=0 0');
//   filteredLines.push('a=group:BUNDLE 0');
//   filteredLines.push('a=extmap-allow-mixed');
//   filteredLines.push('a=msid-semantic: WMS');

//   // Add media line
//   if (mediaLine) {
//     filteredLines.push(mediaLine);
//   } else {
//     filteredLines.push('m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126');
//   }

//   // Add required media attributes
//   filteredLines.push('c=IN IP4 0.0.0.0');
//   filteredLines.push('a=rtcp:9 IN IP4 0.0.0.0');
  
//   if (iceUfragLine) {
//     filteredLines.push(iceUfragLine);
//   }
//   if (icePwdLine) {
//     filteredLines.push(icePwdLine);
//   }
  
//   filteredLines.push('a=ice-options:trickle');
  
//   if (fingerprintLine) {
//     filteredLines.push(fingerprintLine);
//   }
  
//   filteredLines.push('a=setup:actpass');
//   filteredLines.push('a=mid:0');
//   filteredLines.push('a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level');
//   filteredLines.push('a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time');
//   filteredLines.push('a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01');
//   filteredLines.push('a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid');
//   filteredLines.push('a=recvonly');
//   filteredLines.push('a=rtcp-mux');
//   filteredLines.push('a=rtcp-rsize');
//   filteredLines.push('a=rtpmap:111 opus/48000/2');
//   filteredLines.push('a=rtcp-fb:111 transport-cc');
//   filteredLines.push('a=fmtp:111 minptime=10;useinbandfec=1');
//   filteredLines.push('a=rtpmap:63 red/48000/2');
//   filteredLines.push('a=fmtp:63 111/111');

//   return filteredLines.join('\n') + '\n';
// }

// /**
//  * Extracts specific SDP parameters for reuse
//  * @param sdp - The input SDP string
//  * @returns Object containing extracted parameters
//  */
// export function extractSdpParams(sdp: string): FilteredSdpParams {
//   const lines = sdp.split('\n').map(line => line.trim());
//   const params: FilteredSdpParams = {};

//   for (const line of lines) {
//     if (line.startsWith('v=')) {
//       params.version = line.substring(2);
//     } else if (line.startsWith('o=')) {
//       params.origin = line.substring(2);
//     } else if (line.startsWith('s=')) {
//       params.sessionName = line.substring(2);
//     } else if (line.startsWith('t=')) {
//       params.timing = line.substring(2);
//     } else if (line.startsWith('a=group:BUNDLE')) {
//       params.bundleGroup = line.substring(15);
//     } else if (line === 'a=extmap-allow-mixed') {
//       params.extmapAllowMixed = true;
//     } else if (line.startsWith('a=msid-semantic:')) {
//       params.msidSemantic = line.substring(16).trim();
//     } else if (line.startsWith('m=')) {
//       params.mediaType = line.substring(2);
//     } else if (line.startsWith('c=')) {
//       params.connectionInfo = line.substring(2);
//     } else if (line.startsWith('a=rtcp:')) {
//       params.rtcp = line.substring(7);
//     } else if (line.startsWith('a=ice-ufrag:')) {
//       params.iceUfrag = line.substring(12);
//     } else if (line.startsWith('a=ice-pwd:')) {
//       params.icePwd = line.substring(10);
//     } else if (line.startsWith('a=ice-options:')) {
//       params.iceOptions = line.substring(14);
//     } else if (line.startsWith('a=fingerprint:')) {
//       params.fingerprint = line.substring(14);
//     } else if (line.startsWith('a=setup:')) {
//       params.setup = line.substring(8);
//     } else if (line.startsWith('a=mid:')) {
//       params.mid = line.substring(6);
//     } else if (line.startsWith('a=extmap:')) {
//       if (!params.extmaps) params.extmaps = [];
//       params.extmaps.push(line.substring(9));
//     } else if (['a=recvonly', 'a=sendonly', 'a=sendrecv', 'a=inactive'].includes(line)) {
//       params.direction = line.substring(2);
//     } else if (line === 'a=rtcp-mux') {
//       params.rtcpMux = true;
//     } else if (line === 'a=rtcp-rsize') {
//       params.rtcpRsize = true;
//     } else if (line.startsWith('a=rtpmap:')) {
//       if (!params.rtpmaps) params.rtpmaps = [];
//       params.rtpmaps.push(line.substring(9));
//     } else if (line.startsWith('a=rtcp-fb:')) {
//       if (!params.rtcpFb) params.rtcpFb = [];
//       params.rtcpFb.push(line.substring(10));
//     } else if (line.startsWith('a=fmtp:')) {
//       if (!params.fmtp) params.fmtp = [];
//       params.fmtp.push(line.substring(7));
//     }
//   }

//   return params;
// }
