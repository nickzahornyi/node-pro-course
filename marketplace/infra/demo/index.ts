import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { opts } from "./local-provider";

pulumi.runtime.registerResourceTransform(args => args.type === "aws:rds/instance:Instance"
  ? { props: { ...args.props, deletionProtection: false, skipFinalSnapshot: true }, opts: args.opts }
  : undefined);
const base = new pulumi.StackReference("organization/hw31-base/base");
const privateSubnets = base.requireOutput("privateSubnetIds") as pulumi.Output<string[]>;
const publicSubnets = base.requireOutput("publicSubnetIds") as pulumi.Output<string[]>;
const subnetGroup = new aws.rds.SubnetGroup("db", { subnetIds: privateSubnets }, opts);
const db = new aws.rds.Instance("db", {
  identifierPrefix: "hw31-db-", engine: "postgres", instanceClass: "db.t4g.micro", multiAz: true,
  allocatedStorage: 20, storageType: "gp3", storageEncrypted: true,
  backupRetentionPeriod: 1, publiclyAccessible: false,
  dbSubnetGroupName: subnetGroup.name, vpcSecurityGroupIds: [base.requireOutput("dbSecurityGroupId")],
  username: "marketplace", password: pulumi.secret("localstack-only-password"),
  performanceInsightsEnabled: false, monitoringInterval: 0,
}, opts);
const alb = new aws.lb.LoadBalancer("alb", { loadBalancerType: "application", internal: false,
  subnets: publicSubnets, securityGroups: [base.requireOutput("albSecurityGroupId")] }, opts);
const target = new aws.lb.TargetGroup("target", { targetType: "lambda",
  healthCheck: { enabled: true, path: "/health", matcher: "200" } }, opts);
const execution = new aws.iam.Role("lambda", { assumeRolePolicy: JSON.stringify({ Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }, opts);
const handler = new aws.lambda.Function("health", { role: execution.arn, runtime: "nodejs22.x",
  handler: "index.handler", code: new pulumi.asset.AssetArchive({ "index.js": new pulumi.asset.StringAsset(
    'exports.handler = async () => ({statusCode:200,statusDescription:"200 OK",isBase64Encoded:false,headers:{"content-type":"application/json"},body:JSON.stringify({service:"marketplace",status:"ok"})});') }) }, opts);
const permission = new aws.lambda.Permission("alb", { action: "lambda:InvokeFunction",
  function: handler.name, principal: "elasticloadbalancing.amazonaws.com", sourceArn: target.arn }, opts);
new aws.lb.TargetGroupAttachment("health", { targetGroupArn: target.arn, targetId: handler.arn }, { ...opts, dependsOn: permission });
new aws.lb.Listener("http", { loadBalancerArn: alb.arn, port: 80, protocol: "HTTP",
  defaultActions: [{ type: "forward", targetGroupArn: target.arn }] }, opts);
if (new pulumi.Config("hw31").getBoolean("withNat")) {
  const eip = new aws.ec2.Eip("nat", { domain: "vpc" }, opts);
  new aws.ec2.NatGateway("nat", { allocationId: eip.id, subnetId: publicSubnets.apply(ids => ids[0]) }, opts);
}
export const dbIdentifier = db.identifier;
export const albDns = alb.dnsName;
export const targetGroupArn = target.arn;
