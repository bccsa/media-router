export { Engine } from './Engine.js';
export type { EngineConfig } from './Engine.js';
export { PluginLoader } from './plugins/PluginLoader.js';
export type {
    PluginModule,
    PipelineDescription,
    EngineServices,
    ModuleServices,
} from './plugins/PluginModule.js';
export { DeviceProviderRegistry } from './system/DeviceProviderRegistry.js';
export type { DeviceProvider } from './system/DeviceProviderRegistry.js';
// Re-export `Device` so plugins only need to depend on `@media-router/engine`.
export type { Device } from '@media-router/shared-types';
export { GstPluginBase } from './plugins/GstPluginBase.js';
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
export { ProcessManager } from './child-process/ProcessManager.js';
export { ManagedProcess } from './child-process/ManagedProcess.js';
export type { ManagedProcessOptions } from './child-process/ManagedProcess.js';
export type { ProcessInfo } from './child-process/ProcessManager.js';
export { probeMpegTsStream } from './routing/MpegTsProbe.js';
export type { ProbeResult } from './routing/MpegTsProbe.js';
