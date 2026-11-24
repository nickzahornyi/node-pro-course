import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir = 'evidence/hw31';
mkdirSync(dir, { recursive: true });
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const pulumi = (action, stack='base') => run('bash', ['scripts/hw31.sh', action, stack]);
const aws = (service, ...args) => JSON.parse(run('docker', ['compose','-f','infra/hw31-compose.yml','exec','-T','localstack',
  'awslocal',service,...args,'--region','eu-central-1','--output','json']));
const raw = pulumi('export');
writeFileSync(`${dir}/base-state.json`, raw);
const outputs = JSON.parse(pulumi('outputs'));
const subnets = aws('ec2','describe-subnets','--filters',`Name=vpc-id,Values=${outputs.vpcId}`).Subnets;
const tables = aws('ec2','describe-route-tables','--filters',`Name=vpc-id,Values=${outputs.vpcId}`).RouteTables;
const groups = aws('ec2','describe-security-groups','--filters',`Name=vpc-id,Values=${outputs.vpcId}`).SecurityGroups;
const tagged = aws('resourcegroupstaggingapi','get-resources','--tag-filters','Key=Project,Values=nodejs-pro-hw31').ResourceTagMappingList;
const priv = new Set(outputs.privateSubnetIds);
// Resolve explicit associations; fail if a private subnet has no table evidence.
const privateTables = tables.filter(t => t.Associations.some(a => priv.has(a.SubnetId)));
assert.equal(privateTables.length, 2);
const evidence = {
 'vpc-id': outputs.vpcId,
 'public-subnets': subnets.filter(s => s.MapPublicIpOnLaunch).length,
 'private-subnets': subnets.filter(s => !s.MapPublicIpOnLaunch).length,
 'subnet-azs': new Set(subnets.map(s => s.AvailabilityZone)).size,
 'private-default-route': privateTables.flatMap(t => t.Routes).filter(r => r.DestinationCidrBlock === '0.0.0.0/0').length,
 'security-groups': groups.filter(g => g.GroupName !== 'default').length,
 'tagged-resources': tagged.length,
};
assert.equal(evidence['public-subnets'],2); assert.equal(evidence['private-subnets'],2);
assert.equal(evidence['subnet-azs'],2); assert.equal(evidence['private-default-route'],0);
assert.ok(evidence['security-groups'] >= 2); assert.ok(tagged.length >= 8);
const resources = JSON.parse(raw).deployment.resources;
assert.equal(resources.filter(r => /aws:rds\/|aws:lb\/|aws:ec2\/(natGateway|instance|eip):/.test(r.type)).length,0);
const lines=Object.entries(evidence).map(([k,v]) => `${k}=${v}`).join('\n')+'\n';
writeFileSync(`${dir}/base.txt`,lines); console.log(lines);
const role=aws('iam','get-role','--role-name',outputs.roleName);
const policies=aws('iam','list-role-policies','--role-name',outputs.roleName).PolicyNames.map(name =>
 aws('iam','get-role-policy','--role-name',outputs.roleName,'--policy-name',name));
writeFileSync(`${dir}/iam.json`,JSON.stringify({ ...role, policies },null,2)+'\n');
writeFileSync(`${dir}/iam.txt`,'simulation=not-evaluated-localstack\nSee localstack-iam.txt: policy enforcement is not implemented.\n');
