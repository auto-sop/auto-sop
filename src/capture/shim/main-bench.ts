import { spawnWriter } from './handoff.js';
import main from './main-core.js';

const benchWriter = process.env.AUTO_SOP_BENCH_WRITER ?? process.env.CLAUDE_SOP_BENCH_WRITER;
if (!benchWriter) {
  throw new Error('Neither AUTO_SOP_BENCH_WRITER nor CLAUDE_SOP_BENCH_WRITER is set');
}
main(spawnWriter, benchWriter);
