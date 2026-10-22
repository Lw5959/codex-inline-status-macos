// Child-process-local fixture: exercise the real coordinator with deterministic
// numeric backend replies, without reading any user's Codex logs.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (!args?.some(arg => String(arg).endsWith('native_status_backend.py'))) {
    return originalSpawn(command, args, options);
  }
  const child = new EventEmitter();
  child.pid = 73400;
  child.stdout = new PassThrough();
  let buffered = '';
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      buffered += chunk.toString();
      while (buffered.includes('\n')) {
        const end = buffered.indexOf('\n');
        const request = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        const tps = request.thread_id.startsWith('bbbbbbbb') ? 42 : 112;
        const metrics = {
          scope: 'sampled_session', measurement_method: 'turn_elapsed', tps, measured_samples: 2,
          measured_tokens: tps * 2, measured_seconds: 2,
          cache_hit: .95, context_used: .25, issue: null,
        };
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, metrics }) + '\n'));
      }
      done();
    },
  });
  child.kill = () => { child.stdout.end(); child.emit('exit', 0, null); return true; };
  return child;
};
syncBuiltinESMExports();
