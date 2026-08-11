const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'bridge', 'context-adapter.js'), 'utf8');
const start = src.indexOf('function withSpawnForkFix');
if (start < 0) { console.error('FAIL: withSpawnForkFix no encontrada'); process.exit(1); }
let i = start, depth = 0, inStr = null, esc = false;
for (; i < src.length; i++) {
  const c = src[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === inStr) inStr = null; continue; }
  if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
}
const fn = new Function('return ' + src.slice(start, i))();
let pass = 0, fail = 0;
function check(label, got, expect) {
  const ok = expect(got);
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + '  ->  ' + got);
  ok ? pass++ : fail++;
}
const J = (o) => JSON.stringify(o);
check('agent_type sin fork -> fork_turns none', fn('spawn_agent', J({task_name:'t', agent_type:'supervisor_thinker', message:'m'})), (g) => g.includes('"fork_turns":"none"') && g.includes('"agent_type":"supervisor_thinker"'));
check('agent_type + fork all -> none', fn('spawn_agent', J({task_name:'t', agent_type:'a', fork_turns:'all', message:'m'})), (g) => g.includes('"fork_turns":"none"'));
const noTouch1 = J({task_name:'t', agent_type:'a', fork_turns:'none', message:'m'});
check('agent_type + fork none -> intacto (===)', fn('spawn_agent', noTouch1), (g) => g === noTouch1);
const noTouch2 = J({task_name:'t', agent_type:'a', fork_turns:'3', message:'m'});
check('agent_type + fork 3 -> intacto (===)', fn('spawn_agent', noTouch2), (g) => g === noTouch2);
check('fork_context true -> false (+none)', fn('spawn_agent', J({task_name:'t', agent_type:'a', fork_context:true, message:'m'})), (g) => g.includes('"fork_context":false') && g.includes('"fork_turns":"none"'));
const noTouch3 = J({task_name:'t', message:'m'});
check('sin agent_type -> intacto (===)', fn('spawn_agent', noTouch3), (g) => g === noTouch3);
const noTouch4 = J({message:'hi'});
check('send_message -> intacto (===)', fn('send_message', noTouch4), (g) => g === noTouch4);
const bad = 'not-json{';
check('args invalido -> intacto (===)', fn('spawn_agent', bad), (g) => g === bad);
check('agent_type + fork all + fork_context true -> ambos', fn('spawn_agent', J({task_name:'t', agent_type:'a', fork_turns:'all', fork_context:true})), (g) => g.includes('"fork_turns":"none"') && g.includes('"fork_context":false'));
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);

