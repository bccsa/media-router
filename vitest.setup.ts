// Bus and sink fragments name `mrlateness` only when its .so is built; pin it
// present so pipeline-string tests do not depend on whether `make native` ran.
import { setLatenessTapAvailable } from './packages/engine/src/plugins/latenessTap.js';

setLatenessTapAvailable(true);
