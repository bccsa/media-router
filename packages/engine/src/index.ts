export { Engine } from './Engine.js';
export type { EngineConfig } from './Engine.js';
export { PluginLoader } from './plugins/PluginLoader.js';
export type {
    PluginModule,
    PipelineDescription,
    BusReport,
    PadLinkRule,
    RistRunnerConfig,
    TsProbeRunnerConfig,
    BacklogShedConfig,
    EngineServices,
    ModuleServices,
    DynamicPort,
} from './plugins/PluginModule.js';
export { DeviceProviderRegistry } from './system/DeviceProviderRegistry.js';
export type { DeviceProvider } from './system/DeviceProviderRegistry.js';
export { registerPipeWireDeviceProvider } from './system/pipeWireDeviceProvider.js';
export type { PipeWireDeviceProviderOptions } from './system/pipeWireDeviceProvider.js';
export {
    registerNetworkInterfaceDeviceProvider,
    listNetworkInterfaces,
    interfaceAddress,
    NETWORK_INTERFACE_DEVICE_TYPE,
} from './system/networkInterfaceProvider.js';
export { listV4l2Devices, cachedV4l2Devices, parseFormats } from './system/v4l2Devices.js';
export {
    registerV4l2DeviceProvider,
    acquireV4l2Demand,
    releaseV4l2Demand,
    suspendV4l2Enumeration,
    listV4l2DevicesOnDemand,
    V4L2_DEVICE_TYPE,
    V4L2_IDLE_ENUMERATE_MS,
} from './system/v4l2DeviceProvider.js';
export {
    kernelLogSignalEvent,
    kernelLogWatchMode,
    kmsgMessageText,
    matchKernelLogSignal,
    offKernelLogSignal,
    onKernelLogSignal,
    resetKernelLogWatch,
    startKernelLogWatch,
    stopKernelLogWatch,
    DMESG_POLL_INTERVAL_MS,
    KERNEL_LOG_SIGNALS,
    KMSG_POLL_INTERVAL_MS,
} from './system/kernelLogWatch.js';
export type {
    KernelLogSignalId,
    KernelLogSignalEvent,
    KernelLogSignalHandler,
    KernelLogSource,
    KernelLogWatchOptions,
} from './system/kernelLogWatch.js';
export {
    firstConnectedDisplay,
    listDrmConnectors,
    pickActiveDisplay,
    resolveConnectorId,
    resolveConnectorMode,
} from './system/drmConnectors.js';
export type { ConnectorMode } from './system/drmConnectors.js';
export type { ActiveDisplayChoice } from './system/drmConnectors.js';
export {
    probeGstElement,
    gstInspectMaxChannels,
    gstElementSupportsCaps,
    findLadspaElement,
} from './plugins/gstInspect.js';
export {
    ENCODER_ELEMENTS,
    SPEED_PRESETS,
    H264_PROFILES,
    resolveImpl,
    buildEncoderBranch,
    buildV4l2ExtraControls,
} from './plugins/encoderElements.js';
export type {
    CodecId,
    ImplId,
    RateControl,
    SpeedPreset,
    H264Profile,
    EncoderBranchOptions,
} from './plugins/encoderElements.js';
export {
    probeEncoderAvailability,
    applyEncoderAvailabilityToManifest,
} from './plugins/encoderManifest.js';
export { ProbedEncoders } from './plugins/probedEncoders.js';
export type { HwScalerAvailability, ProbeEncodersOptions } from './plugins/probedEncoders.js';
export { buildEncodeLeaf } from './plugins/encoderLeaf.js';
export { parseResolution } from './plugins/videoGeometry.js';
export { ensureWaylandEnv } from './system/waylandEnv.js';
export type { EncodeLeafOptions } from './plugins/encoderLeaf.js';
export { ThroughputPoller } from './plugins/ThroughputPoller.js';
export type { ThroughputSample, ThroughputPollerOptions } from './plugins/ThroughputPoller.js';
export {
    buildBusSrc,
    buildBusSink,
    busSocketPath,
    busTeeName,
    busEdgeSocketPath,
    busIngestSocketPath,
    BUS_TS_CAPS,
    BUS_WATCHDOG_PREFIX,
} from './plugins/busHelpers.js';
export type { BusSrcOpts } from './plugins/busHelpers.js';
export {
    buildNetUdpSrc,
    buildNetUdpSink,
    isMulticastAddr,
    NET_UDP_RCV_BUF,
} from './plugins/netUdpHelpers.js';
export type { NetUdpSrcOpts, NetUdpSinkOpts } from './plugins/netUdpHelpers.js';
// SMPTE-302M helpers are NOT here: they live in the `audio-302m-core`
// library plugin (ADR-0001), which imports the engine, not the reverse
// (ADR-0002). Import them from `@media-router/plugin-audio-302m-core`.
export {
    aes67DepayloaderElement,
    aes67PayloaderElement,
    aes67PayloadBytes,
    aes67PtimeClauses,
    aes67RawCaps,
    aes67RawFormat,
    aes67RtpCaps,
    aes67SamplesPerPacket,
    clampChannels,
    clampPayloadType,
    clampPtime,
    AES67_DEFAULT_DSCP,
    AES67_DEFAULT_PTIME_MS,
    AES67_SAMPLE_RATE,
    AES67_SAP_GROUP,
    AES67_SAP_PORT,
} from './plugins/aes67Helpers.js';
export type { Aes67Encoding, Aes67RtpCapsOpts } from './plugins/aes67Helpers.js';
// Re-exported for plugins (per-connection channel maps on mix inputs) —
// plugin packages depend on @media-router/engine only, not shared-types.
export type { ChannelMapEntry } from '@media-router/shared-types';
// The `graph` status-field contract — a plugin computes its own plots and
// publishes them with `setStatusGraph`; the UI only renders.
export type {
    StatusGraph,
    StatusValue,
    GraphAxis,
    GraphMarker,
    GraphPoint,
    GraphRole,
    GraphScale,
    GraphSeries,
    GraphStroke,
} from '@media-router/shared-types';
export {
    DEFAULT_MPEGTS_ALIGNMENT,
    TS_VIDEO_PID_BASE,
    TS_AUDIO_PID_BASE,
    TS_METADATA_PID,
    videoStreamPid,
    audioStreamPid,
    muxSinkPadName,
    buildLeakyQueue,
    buildBackpressureQueue,
    buildTsUdpInput,
} from './plugins/tsHelpers.js';
export type { TsUdpInputOpts } from './plugins/tsHelpers.js';
export { capsStreamInfo } from './plugins/streamCapsInfo.js';
export type { StreamCapsInfo } from './plugins/streamCapsInfo.js';
export { formatBytes, formatBitrate, bitrateBadge, SrtStatPoller } from './plugins/srtHelpers.js';
export type { SrtDirection, SrtStatPollerHost } from './plugins/srtHelpers.js';
export { PacedTsSink, packetizeTs, TS_PACKET_BYTES } from './plugins/PacedTsSink.js';
export { PacedUnixStreamTsSink } from './plugins/PacedUnixStreamTsSink.js';
// Re-export `Device` so plugins only need to depend on `@media-router/engine`.
export type { Device } from '@media-router/shared-types';
export {
    effectivePlayoutOffsetMs,
    effectivePlayoutOffsetNs,
    parsePlayoutOffsetMs,
    resolveEnginePlayoutOffsetMs,
    DEFAULT_PLAYOUT_OFFSET_MS,
    MAX_PLAYOUT_OFFSET_MS,
    PLAYOUT_OFFSET_KEY,
} from './plugins/playoutOffset.js';
export type {
    PlayoutOffsetOptions,
    PlayoutOffsetServices,
    PlayoutOffsetRouteSource,
} from './plugins/playoutOffset.js';
export {
    backlogShedConfig,
    BACKLOG_SHED_EVENT,
    BACKLOG_SHED_TOLERANCE_MS,
    BACKLOG_SHED_HOLD_MS,
    BACKLOG_SHED_COOLDOWN_MS,
    BACKLOG_SHED_SANITY_MS,
} from './plugins/backlogShed.js';
export type { BacklogShedOptions, BacklogShedServices } from './plugins/backlogShed.js';
export { GstPluginBase } from './plugins/GstPluginBase.js';
export { DeviceWatchdog } from './plugins/DeviceWatchdog.js';
export type { DeviceWatchdogOptions, DeviceWatchdogPipeWire } from './plugins/DeviceWatchdog.js';
export { PaCommandQueue } from './audio/PaCommandQueue.js';
export { ModuleManager } from './modules/ModuleManager.js';
export { ModuleInstance } from './modules/ModuleInstance.js';
export { MediaRouter } from './routing/MediaRouter.js';
export { ManagerConnection } from './comms/ManagerConnection.js';
export { LcpServer } from './comms/LcpServer.js';
export { ProfileStore } from './api/ProfileStore.js';
export { GstChildProcess } from './child-process/GstChildProcess.js';
export { ChildProcessManager } from './child-process/ChildProcessManager.js';
export { ControlIpc } from './child-process/ControlIpc.js';
export { PipeWireManager } from './audio/PipeWireManager.js';
export {
    detectDeviceFormat,
    resolveDeviceFormat,
    tryResolveDeviceFormat,
} from './audio/deviceFormat.js';
export type { DeviceFormatState, DeviceDetection } from './audio/deviceFormat.js';
export { ProcessManager } from './child-process/ProcessManager.js';
export { ManagedProcess } from './child-process/ManagedProcess.js';
export type { ManagedProcessOptions } from './child-process/ManagedProcess.js';
export {
    UnixFdFanoutController,
    NativeSinkController,
} from './child-process/UnixFdFanoutController.js';
export { probeUnixSocket } from './child-process/busSocketGate.js';
export type { BusAttachTarget, LiveSwapTarget } from './child-process/UnixFdFanoutController.js';
export { resolveNativeBinary, resolvePythonScript } from './child-process/nativeBinaries.js';
export type { ProcessInfo } from './child-process/ProcessManager.js';
export { probeMpegTsStream, classifyCaps, registerCodecClassifier } from './routing/MpegTsProbe.js';
export type { ProbeResult, CodecClassifier } from './routing/MpegTsProbe.js';
export { StreamTypeExecutorRegistry, makeConnLabel } from './routing/StreamTypeExecutor.js';
export type { StreamTypeExecutor } from './routing/StreamTypeExecutor.js';
export { PcmAudioExecutor } from './routing/PcmAudioExecutor.js';
export { MpegTsBusExecutor } from './routing/MpegTsBusExecutor.js';
