import { spawnWriter } from './handoff.js';
import main from './main-core.js';

main(spawnWriter, process.env.CLAUDE_SOP_BENCH_WRITER!);
