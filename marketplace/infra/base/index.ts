import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { opts } from "./local-provider";

// LocalStack Community does not implement Budgets. The real definition remains
// reviewable and previewable; local up explicitly skips this unsupported service.
const budget = process.env.HW31_SKIP_BUDGET === "1" ? undefined : new aws.budgets.Budget("budget", {
  budgetType: "COST", timeUnit: "MONTHLY", limitAmount: "5", limitUnit: "USD",
  notifications: [{ comparisonOperator: "GREATER_THAN", threshold: 20,
    thresholdType: "PERCENTAGE", notificationType: "ACTUAL",
    subscriberEmailAddresses: ["hw31@example.invalid"] }],
}, opts);
const networkOpts = { ...opts, dependsOn: budget ? [budget] : [] };
const vpc = new aws.ec2.Vpc("vpc", { cidrBlock: "10.231.0.0/16", enableDnsHostnames: true }, networkOpts);
const igw = new aws.ec2.InternetGateway("igw", { vpcId: vpc.id }, opts);
const publicTable = new aws.ec2.RouteTable("public", { vpcId: vpc.id,
  routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }] }, opts);
const publicSubnets: aws.ec2.Subnet[] = [], privateSubnets: aws.ec2.Subnet[] = [];
const privateTables: aws.ec2.RouteTable[] = [];
for (const [i, az] of ["eu-central-1a", "eu-central-1b"].entries()) {
  const pub = new aws.ec2.Subnet(`public-${i}`, { vpcId: vpc.id,
    cidrBlock: `10.231.${i}.0/24`, availabilityZone: az, mapPublicIpOnLaunch: true }, opts);
  const priv = new aws.ec2.Subnet(`private-${i}`, { vpcId: vpc.id,
    cidrBlock: `10.231.${10+i}.0/24`, availabilityZone: az, mapPublicIpOnLaunch: false }, opts);
  const table = new aws.ec2.RouteTable(`private-${i}`, { vpcId: vpc.id, routes: [] }, opts);
  new aws.ec2.RouteTableAssociation(`public-${i}`, { subnetId: pub.id, routeTableId: publicTable.id }, opts);
  new aws.ec2.RouteTableAssociation(`private-${i}`, { subnetId: priv.id, routeTableId: table.id }, opts);
  publicSubnets.push(pub); privateSubnets.push(priv); privateTables.push(table);
}
const albSg = new aws.ec2.SecurityGroup("alb", { vpcId: vpc.id,
  // Public HTTP for the homework ALB probe. Lambda targets need no SG egress.
  ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] }], egress: [] }, opts);
const appSg = new aws.ec2.SecurityGroup("app", { vpcId: vpc.id, ingress: [],
  // Only PostgreSQL connections within this VPC; no internet egress.
  egress: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, cidrBlocks: ["10.231.0.0/16"] }] }, opts);
const dbSg = new aws.ec2.SecurityGroup("db", { vpcId: vpc.id,
  // Database accepts PostgreSQL only from application security group members.
  ingress: [{ protocol: "tcp", fromPort: 5432, toPort: 5432, securityGroups: [appSg.id] }], egress: [] }, opts);
const oidc = new aws.iam.OpenIdConnectProvider("github", {
  url: "https://token.actions.githubusercontent.com", clientIdLists: ["sts.amazonaws.com"],
}, opts);
const role = new aws.iam.Role("teardown", {
  assumeRolePolicy: oidc.arn.apply(arn => JSON.stringify({ Version: "2012-10-17", Statement: [{
    Effect: "Allow", Principal: { Federated: arn }, Action: "sts:AssumeRoleWithWebIdentity",
    Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      StringLike: { "token.actions.githubusercontent.com:sub": "repo:nickzahornyi/node-pro-course:ref:refs/heads/hw-31" } },
  }] })),
}, opts);
// Reviewable demo teardown policy. Enforcement must be tested on AWS separately.
// Local teardown uses dummy keys, never a claimed OIDC security check.
export const permissionPolicy = JSON.stringify({ Version: "2012-10-17", Statement: [{
  Effect: "Allow", Action: ["ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeRouteTables",
    "ec2:DescribeSecurityGroups", "ec2:DescribeNatGateways", "ec2:DescribeAddresses",
    "rds:DescribeDBInstances", "elasticloadbalancing:DescribeLoadBalancers", "tag:GetResources"], Resource: "*",
}, {
  Effect: "Allow", Action: ["rds:DeleteDBInstance", "rds:DeleteDBSubnetGroup", "rds:DescribeDBSubnetGroups", "rds:ListTagsForResource"],
  Resource: ["arn:aws:rds:eu-central-1:000000000000:db:hw31-db-*", "arn:aws:rds:eu-central-1:000000000000:subgrp:db-*"],
}, {
  Effect: "Allow", Action: ["elasticloadbalancing:DeleteLoadBalancer", "elasticloadbalancing:DeleteTargetGroup",
    "elasticloadbalancing:DeleteListener", "elasticloadbalancing:DeregisterTargets"],
  Resource: ["arn:aws:elasticloadbalancing:eu-central-1:000000000000:loadbalancer/app/alb-*/*",
    "arn:aws:elasticloadbalancing:eu-central-1:000000000000:targetgroup/target-*/*",
    "arn:aws:elasticloadbalancing:eu-central-1:000000000000:listener/app/alb-*/*/*"],
}, {
  Effect: "Allow", Action: ["elasticloadbalancing:DescribeTargetGroups",
    "elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeTags",
    "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroupAttributes"],
  Resource: "*",
}, {
  Effect: "Allow", Action: ["lambda:DeleteFunction", "lambda:RemovePermission", "lambda:GetFunction", "lambda:GetPolicy", "lambda:ListTags"],
  Resource: "arn:aws:lambda:eu-central-1:000000000000:function:health-*",
}, {
  Effect: "Allow", Action: ["iam:GetRole", "iam:DeleteRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole"],
  Resource: "arn:aws:iam::000000000000:role/lambda-*",
}, {
  Effect: "Allow", Action: ["ec2:DeleteNatGateway", "ec2:ReleaseAddress"], Resource: "*",
  Condition: { StringEquals: { "aws:ResourceTag/Project": "nodejs-pro-hw31", "aws:ResourceTag/Stack": "demo" } },
}] });
new aws.iam.RolePolicy("inventory", { role: role.id, policy: permissionPolicy }, opts);
export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.map(s => s.id);
export const privateSubnetIds = privateSubnets.map(s => s.id);
export const privateRouteTableIds = privateTables.map(t => t.id);
export const albSecurityGroupId = albSg.id;
export const dbSecurityGroupId = dbSg.id;
export const roleName = role.name;
export const roleArn = role.arn;
