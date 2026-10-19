import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ref = name => ({ Ref: name });
const sub = value => ({ 'Fn::Sub': value });
const attr = (name, key) => ({ 'Fn::GetAtt': [name, key] });
const tag = [{ Key: 'Project', Value: 'AgentsOffice' }];
let bootstrap = readFileSync('deployment/bootstrap.sh', 'utf8');
for (const [token, replacement] of Object.entries({
  REGION: '${AWS::Region}', STACK_NAME: '${AWS::StackName}',
  RELEASE_COMMIT: '${ReleaseCommit}', LOGIN_SECRET_ARN: '${LoginSecret}',
})) bootstrap = bootstrap.replaceAll(`__${token}__`, replacement);
const template = {
  AWSTemplateFormatVersion: '2010-09-09',
  Description: 'Current Agents Office full backend: private workspace, EC2 Docker, CloudFront VPC origin and Basic authentication. No provider API keys included.',
  Parameters: {
    ReleaseCommit: { Type: 'String', AllowedPattern: '[a-f0-9]{40}', Description: 'Full 40-character reviewed Git commit from catflyx520/agents-office.' },
    InstanceType: { Type: 'String', Default: 't4g.small', AllowedValues: ['t4g.micro', 't4g.small', 't4g.medium'], Description: '2 GiB initially, as selected by the owner.' },
    CloudFrontSourceSecurityGroupId: { Type: 'String', Default: '', AllowedPattern: '^$|^sg-[a-f0-9]{8,17}$', Description: 'After initial creation, enter the AWS-managed CloudFront-VPCOrigins-Service-SG ID in this stack VPC to enable origin traffic.' },
    LatestAmi: { Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', Default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64' },
  },
  Conditions: { HasCloudFrontSourceGroup: { 'Fn::Not': [{ 'Fn::Equals': [ref('CloudFrontSourceSecurityGroupId'), ''] }] } },
  Resources: {
    Vpc: { Type: 'AWS::EC2::VPC', Properties: { CidrBlock: '10.71.0.0/16', EnableDnsSupport: true, EnableDnsHostnames: true, Tags: tag } },
    Gateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: tag } },
    GatewayAttachment: { Type: 'AWS::EC2::VPCGatewayAttachment', Properties: { VpcId: ref('Vpc'), InternetGatewayId: ref('Gateway') } },
    Subnet: { Type: 'AWS::EC2::Subnet', Properties: { VpcId: ref('Vpc'), CidrBlock: '10.71.0.0/24', MapPublicIpOnLaunch: true, Tags: tag } },
    RouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: ref('Vpc'), Tags: tag } },
    DefaultRoute: { Type: 'AWS::EC2::Route', DependsOn: 'GatewayAttachment', Properties: { RouteTableId: ref('RouteTable'), DestinationCidrBlock: '0.0.0.0/0', GatewayId: ref('Gateway') } },
    SubnetRoute: { Type: 'AWS::EC2::SubnetRouteTableAssociation', Properties: { SubnetId: ref('Subnet'), RouteTableId: ref('RouteTable') } },
    SecurityGroup: { Type: 'AWS::EC2::SecurityGroup', Properties: {
      GroupDescription: 'HTTP only from the dedicated VPC, used by CloudFront private origin ENIs; no SSH or Internet ingress', VpcId: ref('Vpc'),
      SecurityGroupIngress: [{ 'Fn::If': ['HasCloudFrontSourceGroup',
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, SourceSecurityGroupId: ref('CloudFrontSourceSecurityGroupId') },
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '10.71.0.0/16' },
      ] }],
      Tags: tag,
    } },
    LoginSecret: { Type: 'AWS::SecretsManager::Secret', DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain', Properties: {
      Description: 'Private Agents Office website login. Not a provider API key.',
      GenerateSecretString: { SecretStringTemplate: '{"username":"office"}', GenerateStringKey: 'password', PasswordLength: 32, ExcludePunctuation: true }, Tags: tag,
    } },
    InstanceRole: { Type: 'AWS::IAM::Role', Properties: {
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      ManagedPolicyArns: [sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore')],
      Policies: [{ PolicyName: 'ReadOwnWebsiteLogin', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('LoginSecret') },
        { Effect: 'Allow', Action: 'cloudformation:SignalResource', Resource: ref('AWS::StackId') },
      ] } }],
    } },
    InstanceProfile: { Type: 'AWS::IAM::InstanceProfile', Properties: { Roles: [ref('InstanceRole')] } },
    OfficeInstance: { Type: 'AWS::EC2::Instance', DependsOn: ['DefaultRoute', 'SubnetRoute'],
      CreationPolicy: { ResourceSignal: { Count: 1, Timeout: 'PT30M' } },
      Properties: {
        ImageId: ref('LatestAmi'), InstanceType: ref('InstanceType'), IamInstanceProfile: ref('InstanceProfile'),
        SubnetId: ref('Subnet'), SecurityGroupIds: [ref('SecurityGroup')],
        CreditSpecification: { CPUCredits: 'standard' },
        MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1 },
        BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 20, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: false } }],
        UserData: { 'Fn::Base64': sub(bootstrap) }, Tags: [...tag, { Key: 'Name', Value: 'AgentsOffice-private-workspace' }],
      },
    },
    VpcOrigin: { Type: 'AWS::CloudFront::VpcOrigin', DependsOn: 'GatewayAttachment', Properties: {
      VpcOriginEndpointConfig: { Name: sub('${AWS::StackName}-office'), Arn: sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${OfficeInstance}'), HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'http-only', OriginSSLProtocols: ['TLSv1.2'] },
    } },
    CachePolicy: { Type: 'AWS::CloudFront::CachePolicy', Properties: { CachePolicyConfig: {
      Name: sub('${AWS::StackName}-no-cache'), MinTTL: 0, DefaultTTL: 0, MaxTTL: 0,
      ParametersInCacheKeyAndForwardedToOrigin: { EnableAcceptEncodingGzip: false, EnableAcceptEncodingBrotli: false,
        HeadersConfig: { HeaderBehavior: 'none' }, CookiesConfig: { CookieBehavior: 'none' }, QueryStringsConfig: { QueryStringBehavior: 'none' } },
    } } },
    HeadersPolicy: { Type: 'AWS::CloudFront::ResponseHeadersPolicy', Properties: { ResponseHeadersPolicyConfig: {
      Name: sub('${AWS::StackName}-headers'), SecurityHeadersConfig: {
        ContentTypeOptions: { Override: true }, FrameOptions: { FrameOption: 'DENY', Override: true },
        ReferrerPolicy: { ReferrerPolicy: 'no-referrer', Override: true }, StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, Override: true },
      },
    } } },
    Distribution: { Type: 'AWS::CloudFront::Distribution', Properties: { DistributionConfig: {
      Enabled: true, Comment: 'Agents Office private full application', PriceClass: 'PriceClass_100', HttpVersion: 'http2and3', IPV6Enabled: true,
      Origins: [{ Id: 'OfficeVpc', DomainName: attr('OfficeInstance', 'PrivateDnsName'), VpcOriginConfig: { VpcOriginId: attr('VpcOrigin', 'Id'), OriginReadTimeout: 60, OriginKeepaliveTimeout: 60 } }],
      DefaultCacheBehavior: { TargetOriginId: 'OfficeVpc', ViewerProtocolPolicy: 'redirect-to-https',
        AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachedMethods: ['GET', 'HEAD'], Compress: true,
        CachePolicyId: ref('CachePolicy'), OriginRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3', ResponseHeadersPolicyId: ref('HeadersPolicy') },
      CustomErrorResponses: [403, 500, 502, 503, 504].map(code => ({ ErrorCode: code, ErrorCachingMinTTL: 0 })),
      ViewerCertificate: { CloudFrontDefaultCertificate: true },
    }, Tags: tag } },
    DeployDocument: { Type: 'AWS::SSM::Document', Properties: { DocumentType: 'Command', Content: {
      schemaVersion: '2.2', description: 'Deploy a reviewed Agents Office Git commit',
      parameters: { Commit: { type: 'String', allowedPattern: '^[a-f0-9]{40}$', interpolationType: 'ENV_VAR' } },
      mainSteps: [{ action: 'aws:runShellScript', name: 'DeployOffice', inputs: { timeoutSeconds: '1200', runCommand: ['/opt/agents-office/deploy-release.sh "$SSM_Commit"'] } }],
    } } },
    PublisherRole: { Type: 'AWS::IAM::Role', Properties: {
      Description: 'Deploy and verify only the Agents Office instance from this repository main', MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
        Principal: { Federated: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com') },
        Condition: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:catflyx520/agents-office:ref:refs/heads/main' } },
      }] },
      Policies: [{ PolicyName: 'DeployOwnOffice', PolicyDocument: { Version: '2012-10-17', Statement: [
        { Effect: 'Allow', Action: 'ssm:SendCommand', Resource: [sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/${OfficeInstance}'), sub('arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:document/${DeployDocument}')] },
        { Effect: 'Allow', Action: 'ssm:GetCommandInvocation', Resource: '*' },
        { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('LoginSecret') },
      ] } }],
    } },
  },
  Outputs: {
    SiteUrl: { Value: sub('https://${Distribution.DomainName}') },
    InstanceId: { Value: ref('OfficeInstance') }, DistributionId: { Value: ref('Distribution') },
    LoginSecretArn: { Value: ref('LoginSecret') }, DeployRoleArn: { Value: attr('PublisherRole', 'Arn') }, DeployDocumentName: { Value: ref('DeployDocument') },
    VpcId: { Value: ref('Vpc') }, InstanceSecurityGroupId: { Value: ref('SecurityGroup') },
  },
};
const r = template.Resources;
assert.equal(r.CachePolicy.Properties.CachePolicyConfig.MaxTTL, 0);
assert.equal(r.SecurityGroup.Properties.SecurityGroupIngress.length, 1);
for (const rule of r.SecurityGroup.Properties.SecurityGroupIngress[0]['Fn::If'].slice(1)) {
  assert.notEqual(rule.CidrIp, '0.0.0.0/0');
  assert.equal(rule.FromPort, 80);
  assert.equal(rule.ToPort, 80);
}
assert.equal(r.OfficeInstance.Properties.MetadataOptions.HttpTokens, 'required');
assert.equal(r.OfficeInstance.Properties.CreditSpecification.CPUCredits, 'standard');
assert.equal(r.Distribution.Properties.DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
assert.ok(!Object.values(r).some(resource => resource.Type === 'AWS::IAM::OIDCProvider'));
const output = JSON.stringify(template, null, 2) + '\n';
assert.ok(Buffer.byteLength(output) < 51200, 'Console upload limit exceeded');
mkdirSync('deployment', { recursive: true });
writeFileSync('deployment/AgentsOfficeHosting.template.json', output);
console.log(`Standalone full-application template prepared and checked (${Buffer.byteLength(output)} bytes).`);
