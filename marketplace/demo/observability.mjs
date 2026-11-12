import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const mode = process.argv[2];
assert(['logs','metrics','trace'].includes(mode), 'Expected logs, metrics or trace');
const build = spawnSync('npm', ['run','build'], { encoding: 'utf8' });
if (build.status !== 0) { process.stderr.write(build.stdout + build.stderr); process.exit(1); }
const child = fork(new URL('./observability-server.mjs', import.meta.url), [], { silent: true });
const lines = []; let pending = ''; let stderr = '';
child.stdout.on('data', chunk => { pending += chunk; const parts = pending.split('\n'); pending = parts.pop(); lines.push(...parts); });
child.stderr.on('data', chunk => { stderr += chunk; });
const timeout = setTimeout(() => { child.kill(); console.error('demo timeout', stderr); process.exitCode = 1; }, 60000);
const ready = Promise.race([once(child, 'message').then(([m]) => m), once(child,'exit').then(() => { throw Error(stderr || 'Server exited before ready'); })]);
const output = values => { for (const [key,value] of Object.entries(values)) console.log(`${key}=${value}`); };
const tp = () => `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
let base;
const request = async (id = '1', header = tp(), options = {}) => {
  const res = await fetch(`${base}/products/${id}/card`, { ...options, headers: { traceparent: header, ...options.headers } });
  await res.text(); return res;
};
const scrape = async () => (await fetch(`${base}/metrics`)).text();
const sample = (text, name, predicate = () => true) => text.split('\n').flatMap(line => {
  const match = line.match(/^([^ {]+)(?:\{(.*)\})?\s+([\d.eE+-]+)$/);
  if (!match || match[1] !== name) return [];
  const labels = Object.fromEntries([...((match[2] || '').matchAll(/(\w+)="([^"]*)"/g))].map(m => [m[1],m[2]]));
  return predicate(labels) ? [{ labels, value: Number(match[3]) }] : [];
});
const route = labels => labels.route === '/products/:productId/card';
const sum = rows => rows.reduce((n,r) => n+r.value,0);
const logs = () => { assert.equal(pending,''); return lines.filter(Boolean).map(line => JSON.parse(line)); };
try {
  const { port } = await ready; base = `http://127.0.0.1:${port}`;
  if (mode === 'logs') {
    const header = tp(); const response = await request('1',header);
    await new Promise(resolve => setTimeout(resolve, 50));
    const single = logs().slice();
    const burst = 8; const headers = Array.from({ length: burst }, tp);
    await Promise.all(headers.map(h => request('1',h)));
    const marker = `bearer-${randomBytes(12).toString('hex')}`, password = `password-${randomBytes(12).toString('hex')}`;
    const secretHeader = tp();
    await (await fetch(`${base}/auth/login`, { method:'POST', headers:{ traceparent:secretHeader, authorization:`Bearer ${marker}`, 'content-type':'application/json' }, body:JSON.stringify({ email:'demo@example.invalid', password }) })).text();
    await new Promise(resolve => setTimeout(resolve, 50));
    const parsed = logs(), id = header.split('-')[1];
    const groups = headers.map(h => parsed.filter(l => l.trace_id === h.split('-')[1]));
    const values = { 'non-json-lines': lines.filter(l => { try { JSON.parse(l); return false; } catch { return true; } }).length,
      layers: new Set(single.map(l => l.layer)).size, 'distinct-trace-ids':new Set(single.map(l => l.trace_id)).size,
      'trace-id-matches-header':Number(single.length > 0 && single.every(l => l.trace_id === id) && response.headers.get('traceparent')?.split('-')[1] === id),
      burst, 'burst-trace-ids':new Set(groups.flat().map(l => l.trace_id)).size,
      'burst-uneven':groups.filter(g => g.length !== single.length || new Set(g.map(l => l.layer)).size < 3).length,
      'secret-req-logged':Number(parsed.some(l => l.trace_id === secretHeader.split('-')[1] && l.event === 'request')),
      'secret-in-logs':Number(lines.some(l => l.includes(marker) || l.includes(password))) };
    output(values);
    assert(values.layers >= 3); assert.equal(values['non-json-lines'],0); assert.equal(values['distinct-trace-ids'],1);
    assert.equal(values['trace-id-matches-header'],1); assert.equal(values['burst-trace-ids'],burst);
    assert.equal(values['burst-uneven'],0); assert.equal(values['secret-req-logged'],1); assert.equal(values['secret-in-logs'],0);
  }
  if (mode === 'metrics') {
    await request(); await request('999'); // Warm every status series before measuring cardinality.
    const before = await scrape(); let ok=0,fail=0;
    for (let n=0;n<60;n++) { const res=await request(n%6 === 0 ? '999' : n===1 ? '998' : '1');
      if (res.status===200) ok++; else if (res.status===500) fail++; else assert.fail(`Unexpected ${res.status}`); }
    const after = await scrape();
    for (let n=1;n<=100;n++) assert.equal((await request(String(n))).status,200);
    const cardinality = await scrape();
    const counts = text => sample(text,'http_requests_total',route);
    const values = { 'sent-ok':ok, 'sent-fail':fail, 'counter-delta':sum(counts(after))-sum(counts(before)),
      'errors-delta':sum(counts(after).filter(r=>r.labels.status==='500'))-sum(counts(before).filter(r=>r.labels.status==='500')),
      'above-top-bucket':sum(sample(cardinality,'http_request_duration_seconds_count',route))-sum(sample(cardinality,'http_request_duration_seconds_bucket',l=>route(l)&&l.le==='120')),
      'series-before':counts(before).length,'series-after':counts(cardinality).length };
    output(values); assert(ok+fail>=50); assert(fail>0); assert.equal(values['counter-delta'],ok+fail);
    assert.equal(values['errors-delta'],fail); assert.equal(values['above-top-bucket'],0); assert.equal(values['series-after'],values['series-before']);
  }
  if (mode === 'trace') {
    const header = tp(); assert.equal((await request('999',header)).status,500);
    const spanMessage = once(child,'message'); child.send('spans'); const [{spans}] = await spanMessage;
    await new Promise(resolve => setTimeout(resolve, 50));
    const id = header.split('-')[1], parent = header.split('-')[2];
    const ids = new Set(spans.map(s=>s.spanId)); const parsed = logs();
    const values = { spans:spans.length, 'orphan-spans':spans.filter(s=>!ids.has(s.parentSpanId)&&s.parentSpanId!==parent).length,
      'trace-matches-header':Number(spans.length>0&&spans.every(s=>s.traceId===id)),
      'trace-matches-log':Number(spans.length>0&&parsed.length>0&&parsed.every(l=>spans.some(s=>s.traceId===l.trace_id))),
      'span-status-error':Number(spans.some(s=>s.kind===1&&s.status===2)) };
    output(values); assert(values.spans>=2); assert.equal(values['orphan-spans'],0);
    assert.equal(values['trace-matches-header'],1); assert.equal(values['trace-matches-log'],1); assert.equal(values['span-status-error'],1);
    if (process.env.TRACE_API_URL) {
      let found=false;
      for(let n=0;n<30;n++) { const res=await fetch(`${process.env.TRACE_API_URL}/api/traces/${id}`);
        if(res.ok) { const trace=await res.json(); if(JSON.stringify(trace).includes(id)) { found=true; break; } }
        await new Promise(resolve=>setTimeout(resolve,500)); }
      assert(found,'Trace not found in trace backend after forceFlush');
    }
  }
} catch (error) { console.error(error, stderr); process.exitCode=1; }
finally {
  if (child.connected) { const exited=once(child,'exit'); child.send('stop'); await exited; }
  clearTimeout(timeout);
}
