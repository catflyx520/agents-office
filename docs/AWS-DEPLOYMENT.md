# Current-version AWS deployment

Status: prepared, awaiting creation of the `AgentsOfficeHosting` stack and live verification. No URL is claimed yet.

This runs the current Express/WebSocket backend, real CLI subprocess support, uploads, and persistent agent/session state. It is **one private workspace for its owner**, not a public shared service, a simulated demo, or a per-user API-key product. The local `npm start` flow remains available.

## What is deployed

- One Amazon Linux 2023 ARM64 EC2 instance (`t4g.small`, 2 GiB), with Docker, Nginx and SSM management.
- The existing application and pinned Claude Code/Codex CLIs run as a non-root user in a container. The application filesystem is read-only; its home/workspace directory is persistent and writable.
- CloudFront provides the HTTPS entry and a **VPC origin** connection to the instance. HTTP is accepted only from the dedicated VPC, not the public Internet. The instance's public IPv4 is for outbound package/provider/SSM access; there is no inbound SSH or public port 3000.
- Nginx checks a generated Basic authentication password for every HTTP and WebSocket request. CloudFront forwards viewer headers and disables caching. Cross-site browser origins are rejected.
- No Root keys, provider credentials, local projects, prior sessions, or private files are copied into the image. Docker cannot access the host Docker socket or instance metadata. The host role can read only this stack's website-login secret plus SSM management and its own stack signal.

The app receives the small changes needed for hosting: `/healthz`, HTTPS-aware `wss:` selection, and WebSocket heartbeat frames. There is no showcase transport or fake execution data. Compatible dependency patches are included; audit warnings remain in the existing dependency tree and are not represented as a clean security audit.

## Cost review before creating

Plan for roughly **US$18–25/month** for a continuously running small instance, 20 GiB gp3 disk, one IPv4 address and one stored secret, before provider API usage and significant traffic. This is a planning estimate, not a price quote or spending cap; eligibility for credits/free trials is not assumed. `t4g.medium` costs more. CPU credits use Standard mode, preventing Unlimited credit surcharges but allowing throttling after credits are exhausted.

There is no NAT gateway, ALB, RDS, or EKS cluster. CloudFront traffic, stored data, requests and model-provider calls may add charges. The existing account budget does not stop spending. Review [EC2 pricing](https://aws.amazon.com/ec2/pricing/on-demand/), [EBS pricing](https://aws.amazon.com/ebs/pricing/), [IPv4 pricing](https://aws.amazon.com/vpc/pricing/), and [Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/).

## Create in the console

Use the existing account `397303793146` in **Ohio / us-east-2**. The existing GitHub OIDC provider is reused; do not create another one.

1. Open [CloudFormation in Ohio](https://us-east-2.console.aws.amazon.com/cloudformation/home?region=us-east-2#/stacks/create/template).
2. Create a standard stack and upload `deployment/AgentsOfficeHosting.template.json`.
3. Stack name: `AgentsOfficeHosting`.
4. `ReleaseCommit`: paste the full reviewed 40-character commit from the successful **Check and deploy current application** workflow. Use the exact commit provided with the handoff.
5. Keep `InstanceType=t4g.small` and the default Amazon Linux AMI parameter.
6. On review, acknowledge IAM resource creation and create the stack yourself.
7. Wait for `CREATE_COMPLETE`. Package/image setup can take several minutes; CloudFront VPC-origin creation can take up to 15 minutes. The instance must report a healthy application and an anonymous 401 response before its resource signal succeeds.

Copy these **non-secret Outputs** back for publication and verification:

| Output | GitHub repository variable |
| --- | --- |
| `InstanceId` | `OFFICE_INSTANCE_ID` |
| `DeployDocumentName` | `OFFICE_DEPLOY_DOCUMENT` |
| `SiteUrl` | `OFFICE_SITE_URL` |
| `LoginSecretArn` | `OFFICE_LOGIN_SECRET_ARN` |
| `DeployRoleArn` | `OFFICE_DEPLOY_ROLE_ARN` |

`DistributionId` is also output for operations. Do not paste the secret's password into chat or GitHub variables.

## Open and verify

In AWS Secrets Manager, open the secret identified by `LoginSecretArn` and choose **Retrieve secret value** yourself. The website username is `office`; use its generated `password` in the browser's authentication prompt at `SiteUrl`.

The publishing workflow obtains temporary GitHub OIDC credentials. It can run only the stack's constrained SSM deployment document on the stack's instance, read deployment status, and retrieve this stack's login secret for verification. It cannot create infrastructure or update other projects. Passwords are masked and not saved as workflow artifacts.

Run **Actions → Check and deploy current application → Run workflow**, `main`, enable deployment. The workflow deploys the reviewed commit, checks anonymous requests are rejected, verifies the real agent roster over authenticated WebSocket, checks cross-site rejection, and keeps the socket open for 70 seconds to verify heartbeat traffic. It does not submit a model task or incur provider usage.

This cloud machine starts with fresh workspace directories. It cannot access the original computer's drives. Real coding work requires adding the intended repository to this workspace and configuring a provider on the server. Existing local OAuth login assumptions may require server-side login/API configuration in this remote environment; the planned browser BYOK flow is not implemented by this deployment. No provider connection or successful model execution is claimed until explicitly configured and tested.

## Maintenance and recovery

- Use the EC2 **Connect → Session Manager** console; no SSH key or inbound SSH rule is needed.
- Initial logs: `/var/log/cloud-init-output.log`. Application: `sudo docker logs agents-office`. Never post logs containing credentials or private task content.
- Website auth hash: `/etc/nginx/office.htpasswd`. Provider environment file: `/etc/agents-office/providers.env` (initially empty, root-only). Workspace data: `/var/lib/agents-office/home`.
- A small instance is an initial hosting size, not a guarantee for several concurrent coding agents. Increase capacity if memory or CPU becomes limiting; do not confuse a hosting smoke check with a load test.
- A failed application health check attempts to start the previous image. Old images are retained for rollback; monitor disk space. Container log files rotate.
- Deleting the stack **retains the root EBS volume and login secret**. These retained resources continue to cost money; inspect them and deliberately remove or back them up when retiring this workspace. There is no automatic backup policy in this initial deployment.
- The initial instance is a single point of failure. This is an owner-operated deployment, not a multi-tenant production service.

## Local checks

```sh
npm ci
npm run check
npm test -- --runInBand
npm run prepare:hosting
```

The GitHub check additionally builds the ARM64 Docker image, verifies both CLI executables, validates shell and CloudFormation syntax, and exercises the real Nginx/backend connection without model credentials.

AWS references: [VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html), [VPC-origin WebSocket support announced May 2026](https://aws.amazon.com/about-aws/whats-new/2026/05/amazon-cloudfront-websockets-vpc-origins/), [WebSockets with CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html), [authorization and caching](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html).

## Later product work

The requested two-version product is a later phase: a public demo as the primary entry, and a separate real-use version with user-supplied API credentials. This deployment does not claim either version has been implemented.
