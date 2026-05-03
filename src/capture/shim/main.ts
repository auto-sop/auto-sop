import { spawnWriter } from './handoff.js';
import { WRITER_ENTRY } from './shim-config.js';
import main from './main-core.js';

main(spawnWriter, WRITER_ENTRY);
