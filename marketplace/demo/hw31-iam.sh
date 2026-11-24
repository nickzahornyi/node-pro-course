#!/usr/bin/env bash
set -euo pipefail
mkdir -p evidence/hw31
compose=(docker compose -f infra/hw31-compose.yml)
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${compose[@]}" exec -T localstack python - <<'PY' | tee evidence/hw31/localstack-iam.txt
import boto3, json, uuid
endpoint='http://localhost:4566'
def client(service, key='test', secret='test'):
 return boto3.client(service,endpoint_url=endpoint,region_name='eu-central-1',aws_access_key_id=key,aws_secret_access_key=secret)
iam=client('iam'); suffix=uuid.uuid4().hex[:10]; user='hw31-deny-'+suffix; bucket='hw31-iam-'+suffix
key=None; created=False
try:
 iam.create_user(UserName=user)
 key=iam.create_access_key(UserName=user)['AccessKey']
 iam.put_user_policy(UserName=user,PolicyName='deny-all',PolicyDocument=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Deny','Action':'*','Resource':'*'}]}))
 s3=client('s3',key['AccessKeyId'],key['SecretAccessKey'])
 res=s3.create_bucket(Bucket=bucket,CreateBucketConfiguration={'LocationConstraint':'eu-central-1'}); created=True
 print('deny-create-bucket='+str(res['ResponseMetadata']['HTTPStatusCode']))
 res=s3.put_object(Bucket=bucket,Key='proof',Body=b'local-only')
 print('deny-all='+str(res['ResponseMetadata']['HTTPStatusCode']))
 res=client('s3','TOTALLY_FAKE_KEY_12345').get_object(Bucket=bucket,Key='proof')
 assert res['Body'].read()==b'local-only'
 print('fake-key='+str(res['ResponseMetadata']['HTTPStatusCode']))
finally:
 if created:
  client('s3').delete_object(Bucket=bucket,Key='proof'); client('s3').delete_bucket(Bucket=bucket)
 if key: iam.delete_access_key(UserName=user,AccessKeyId=key['AccessKeyId'])
 iam.delete_user_policy(UserName=user,PolicyName='deny-all'); iam.delete_user(UserName=user)
PY
"${compose[@]}" logs --no-color --since "$since" localstack > evidence/hw31/localstack-iam-log.txt
count=$(grep -ciE 'AccessDenied|Forbidden|enforc(e|ement|ing)|not authorized|permission denied' evidence/hw31/localstack-iam-log.txt || true)
printf 'enforce-iam-log-lines=%s\n' "$count" | tee -a evidence/hw31/localstack-iam.txt
for key in deny-all=200 fake-key=200 enforce-iam-log-lines=0; do
 grep -qx "$key" evidence/hw31/localstack-iam.txt
done
