import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
// Explicit loopback endpoints and dummy credentials: never inherit a real AWS profile.
const endpoint = "http://127.0.0.1:23166";
const config = new pulumi.Config("aws");
if (config.require("region") !== "eu-central-1") throw new Error("HW31 region must be eu-central-1");
export const provider = new aws.Provider("localstack", {
  region: "eu-central-1", accessKey: "test", secretKey: "test", token: "",
  skipCredentialsValidation: true, skipMetadataApiCheck: true,
  skipRequestingAccountId: true, skipRegionValidation: true,
  s3UsePathStyle: true,
  defaultTags: config.requireObject("defaultTags"),
  endpoints: [{ ec2: endpoint, iam: endpoint, sts: endpoint, budgets: endpoint,
    rds: endpoint, elbv2: endpoint, lambda: endpoint, s3: endpoint,
    cloudwatch: endpoint, cloudwatchlogs: endpoint, resourcegroupstaggingapi: endpoint }],
});
export const opts = { provider };
