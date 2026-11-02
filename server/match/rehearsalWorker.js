// Only detached vanilla battle inputs enter this child. No room, player economy or network objects cross IPC.
import { Battle } from '../sim/Battle.js';
import { DataSource } from '../sim/simdata.js';
import { RehearsalRun } from '../sim/rehearsal.js';
import { morphBattleOpt } from '../../shared/plugins/rules.js';
import { createBattleFromSpec } from '../sim/spec.js';
import { HeadlessJob } from './fields.js';

let source = null;
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
process.on('disconnect', () => process.exit(0));
process.on('message', (message) => {
  if (message?.type === 'init') {
    source = new DataSource(freeze(message.data), null);
    process.send?.({ type: 'ready' });
    return;
  }
  if (message?.type !== 'run' || !source) return;
  try {
    if (message.kind === 'headless') {
      const battle = createBattleFromSpec(message.spec, source, { recordEvents: false, logger: {} });
      const failures = [];
      const job = new HeadlessJob(battle, { players: message.spec.players.map(p => p.playerId),
        onError: error => failures.push(String(error.message || error)) });
      job.run();
      const output = job.output();
      process.send?.({ id: message.id, output: { result: output.result, timeline: output.timeline,
        time: output.battle.time, errors: output.battle.errors || [], failures } });
      return;
    }
    const factories = message.inputs.map((opts) => () => new Battle({ data: source, content: message.content,
      ...opts, ...morphBattleOpt(message.rules), recordEvents: false, quiet: true, logger: {} }));
    let failed = false;
    const run = new RehearsalRun(factories, message.playerId, message.cap, { onError: () => { failed = true; } });
    run.run();
    process.send?.({ id: message.id, ...(failed ? { error: 'rehearsal failed' } : { index: run.score.index }) });
  } catch {
    process.send?.({ id: message.id, error: 'rehearsal failed' });
  }
});
