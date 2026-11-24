import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const stacks=['demo','base'].map(stack => JSON.parse(execFileSync('bash',['scripts/hw31.sh','export',stack],{encoding:'utf8'})));
const left=stacks.flatMap(s=>s.deployment.resources ?? []).filter(r=>r.type.startsWith('aws:')).length;
writeFileSync('evidence/hw31/destroyed-state.json',JSON.stringify(stacks,null,2)+'\n');
writeFileSync('evidence/hw31/demos.txt',`lane=localstack\nstate-resources-left=${left}\nfailover=not-evaluated\nalb=not-evaluated\nnat=not-evaluated\n`);
console.log(`state-resources-left=${left}`);
assert.equal(left,0,'Both Pulumi stacks must be empty');
