import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const image=process.env.IMAGE || 'marketplace:hw28';
const severity='HIGH,CRITICAL',max=Number(process.env.SCAN_MAX ?? 50);
if(!Number.isSafeInteger(max)) throw new Error('SCAN_MAX must be an integer');
const dir=mkdtempSync(join(tmpdir(),'hw28-scan-'));
try {
 const report=join(dir,'report.json');
 const dockerHost=execFileSync('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).trim();
 const result=spawnSync('trivy',['image','--image-src','docker','--scanners','vuln','--ignore-unfixed','--severity',severity,'--format','json','--output',report,image],{env:{...process.env,DOCKER_HOST:process.env.DOCKER_HOST || dockerHost},stdio:'inherit'});
 if(result.status!==0) throw new Error('Trivy failed; no gate verdict without a valid report');
 const data=JSON.parse(readFileSync(report,'utf8'));
 if(!Array.isArray(data.Results)) throw new Error('Invalid Trivy report');
 const found=data.Results.flatMap(r=>r.Vulnerabilities || []).filter(v=>['HIGH','CRITICAL'].includes(v.Severity) && v.FixedVersion).length;
 const pass=found<=max;
 console.log(`image=${image}\nseverity=${severity}\nfound=${found}\nmax-allowed=${max}\ngate=${pass?'pass':'fail'}`);
 process.exitCode=pass?0:1;
} finally {rmSync(dir,{recursive:true,force:true});}
