import * as pulumi from '@pulumi/pulumi';
import * as k8s from '@pulumi/kubernetes';
import {execFileSync} from 'node:child_process';
// Validate before constructing providers or contacting the cluster.
const required=['DB_PASSWORD','AUTH_SECRET','JWT_KID','JWT_PRIVATE_KEY','JWT_PUBLIC_KEY','REFRESH_TOKEN_PEPPER','PULUMI_CONFIG_PASSPHRASE'] as const;
const missing=required.filter(name=>!process.env[name]);
if(missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
const config=new pulumi.Config();
const namespace=config.get('namespace') || 'marketplace-hw28';
const image=process.env.IMAGE || config.get('image') || 'marketplace:hw28';
const profile=process.env.DEPLOY_PROFILE || config.get('profile') || 'hardened';
if(!['hardened','broken'].includes(profile)) throw new Error('profile must be hardened or broken');
const hardened=profile==='hardened';
const cluster=process.env.KIND_CLUSTER_NAME || 'hw28';
const provider=new k8s.Provider('kind',{enableSecretMutable:true,kubeconfig:execFileSync('kind',['get','kubeconfig','--name',cluster],{encoding:'utf8'})});
const options={provider};
const ns=new k8s.core.v1.Namespace('namespace',{metadata:{name:namespace}},options);
const metadata={namespace:ns.metadata.name};
const data=Object.fromEntries(required.filter(name=>name!=='PULUMI_CONFIG_PASSPHRASE').map(name=>[name,Buffer.from(process.env[name]!).toString('base64')]));
const secret=new k8s.core.v1.Secret('runtime',{metadata:{...metadata,name:'marketplace-runtime'},type:'Opaque',data:pulumi.secret(data)},options);
const dbLabels={app:'marketplace-postgres'};
const database=new k8s.apps.v1.Deployment('postgres',{metadata:{...metadata,name:'postgres'},spec:{replicas:1,selector:{matchLabels:dbLabels},strategy:{type:'Recreate'},template:{metadata:{labels:dbLabels},spec:{containers:[{name:'postgres',image:'postgres:17-alpine',imagePullPolicy:'IfNotPresent',env:[{name:'POSTGRES_DB',value:'marketplace'},{name:'POSTGRES_USER',value:'marketplace'},{name:'POSTGRES_PASSWORD',valueFrom:{secretKeyRef:{name:secret.metadata.name,key:'DB_PASSWORD'}}}],ports:[{containerPort:5432}],resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{memory:'384Mi'}},readinessProbe:{exec:{command:['pg_isready','-U','marketplace','-d','marketplace']},periodSeconds:1},volumeMounts:[{name:'data',mountPath:'/var/lib/postgresql/data'}]}],volumes:[{name:'data',emptyDir:{}}]}}}},options);
const dbService=new k8s.core.v1.Service('postgres-service',{metadata:{...metadata,name:'postgres'},spec:{selector:dbLabels,ports:[{port:5432,targetPort:5432}]}},options);
const labels={app:'marketplace-api'};
const env=[{name:'DB_URL',value:'postgresql://marketplace@postgres:5432/marketplace'},{name:'PORT',value:'3000'},{name:'STARTUP_DELAY_MS',value:'4000'},{name:'DRAIN_MS',value:hardened?'5000':'0'}];
// Typed before conditional assignment: probes cannot silently disappear in a spread typo.
const container:k8s.types.input.core.v1.Container={name:'api',image,imagePullPolicy:'IfNotPresent',env,envFrom:[{secretRef:{name:secret.metadata.name}}],ports:[{containerPort:3000,name:'http'}],resources:{requests:{cpu:'100m',memory:'192Mi'},limits:{memory:'384Mi'}},securityContext:{runAsNonRoot:true,runAsUser:65532,runAsGroup:65532,allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}}};
if(hardened) {
 container.readinessProbe={httpGet:{path:'/readyz',port:3000},periodSeconds:1,timeoutSeconds:1,failureThreshold:1};
 container.livenessProbe={httpGet:{path:'/healthz',port:3000},periodSeconds:3,timeoutSeconds:1,failureThreshold:3};
 container.startupProbe={httpGet:{path:'/healthz',port:3000},periodSeconds:1,failureThreshold:30};
}
const deployment=new k8s.apps.v1.Deployment('api',{metadata:{...metadata,name:'marketplace'},spec:{replicas:2,minReadySeconds:hardened?2:0,selector:{matchLabels:labels},strategy:{type:'RollingUpdate',rollingUpdate:{maxUnavailable:hardened?0:1,maxSurge:hardened?1:0}},template:{metadata:{labels,annotations:{'marketplace/revision':process.env.DEPLOY_REVISION || config.get('revision') || 'initial'}},spec:{terminationGracePeriodSeconds:hardened?20:2,securityContext:{seccompProfile:{type:'RuntimeDefault'}},initContainers:[{name:'migrate',image,imagePullPolicy:'IfNotPresent',command:['/nodejs/bin/node','dist/kubernetes/migrate.js'],env:[env[0]],envFrom:[{secretRef:{name:secret.metadata.name}}],securityContext:{runAsNonRoot:true,runAsUser:65532,allowPrivilegeEscalation:false},resources:{requests:{cpu:'100m',memory:'128Mi'},limits:{memory:'256Mi'}}}],containers:[container]}}}},{...options,dependsOn:[database,dbService]});
new k8s.core.v1.Service('api-service',{metadata:{...metadata,name:'marketplace'},spec:{type:'NodePort',selector:labels,ports:[{port:80,targetPort:3000,nodePort:30080}]}},options);
new k8s.policy.v1.PodDisruptionBudget('pdb',{metadata:{...metadata,name:'marketplace'},spec:{minAvailable:1,selector:{matchLabels:labels}}},options);
new k8s.autoscaling.v2.HorizontalPodAutoscaler('hpa',{metadata:{...metadata,name:'marketplace'},spec:{scaleTargetRef:{apiVersion:'apps/v1',kind:'Deployment',name:deployment.metadata.name},minReplicas:2,maxReplicas:4,metrics:[{type:'Resource',resource:{name:'cpu',target:{type:'Utilization',averageUtilization:70}}}]}},options);
export const endpoint='http://127.0.0.1:22800';
export const deployedNamespace=ns.metadata.name;
export const deployedProfile=profile;
