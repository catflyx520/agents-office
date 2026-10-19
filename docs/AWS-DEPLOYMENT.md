# AWS deployment: public Demo + visitor-owned AI

## Current rollout status

The previous private application was deployed and [verified](https://github.com/catflyx520/agents-office/actions/runs/39206895715/attempts/2) on October 18, 2026 (America/Los_Angeles), at commit `4fbd193efb3f4c84d17eb3c93a6843696c69b4d1`.

**Public release deployed and verified on October 19, 2026 (America/Los_Angeles):** [Live Demo](https://d396om3j4lmtlb.cloudfront.net), [successful workflow](https://github.com/catflyx520/agents-office/actions/runs/39339228277), application commit `6f8faeea4fdf95604dc9de8758d607246428810f`. The owner completed the one-time document update below. Password-free HTML/assets, upload rejection, default Demo and its handoffs, visitor-key connection state, cross-site rejection, and a 70-second idle WebSocket heartbeat all passed. The release also passed 51 tests, CloudFormation/ShellCheck validation and the ARM64 image/proxy check. Actual browser QA confirmed the hosted Demo, English interface, Live connection form and the 390 × 844 phone layout with no horizontal document overflow. Captures are in `docs/screenshots/aws-*.jpg`. No paid model call has been made for acceptance.

| Existing resource | Value |
| --- | --- |
| Account / Region | `397303793146` / Ohio `us-east-2` |
| Stack | `AgentsOfficeHosting` |
| Site | https://d396om3j4lmtlb.cloudfront.net |
| Distribution | `E3JKWOH1Q3R2GJ` |
| Instance | `i-0c5c52fb481ee20cc` — `t4g.small` |
| Deployment document | `AgentsOfficeHosting-DeployDocument-YjmUBzOYKILV` |
| CloudFront source group | `sg-08edba2e4f0be6844` |
| VPC | `vpc-017cadbb751145c31` |

## One-time update for the existing stack

Completed for this stack. The steps below remain as a reference for similar upgrades and recovery.

The original instance has an older publishing helper that only replaces the app image. Removing the website password also requires updating the host's Nginx configuration. The existing publishing role cannot change its own SSM document; the owner submits this small CloudFormation update in the console.

1. Open CloudFormation in Ohio and select **AgentsOfficeHosting → Update → Replace existing template → Upload a template file**.
2. Upload the newly generated `deployment/AgentsOfficeHosting.template.json` from this checkout.
3. Keep every parameter at its existing value, including `ReleaseCommit`, `InstanceType=t4g.small`, `LatestAmi`, and `CloudFrontSourceSecurityGroupId=sg-08edba2e4f0be6844`.
4. Review the changes. **Only `DeployDocument` should change**. `UpdateMethod=NewVersion` keeps its existing name and updates the default document version. No EC2, AMI, bootstrap, security group or IAM change is included. If an instance replacement appears, stop and inspect the change set.
5. Acknowledge the IAM notice if shown, submit and wait for **UPDATE_COMPLETE**.
6. Run **GitHub Actions → Check and deploy current application → Run workflow**, `main`, enable deployment. The command downloads the deployment helper from the exact reviewed commit, builds the public image, checks its health, installs `nginx.public.conf` and reloads Nginx. It does not read the old website password or any provider key.
7. Accept the release only after public HTML and assets return 200, `/upload` returns 410, Demo handoffs finish, Live mode requires a visitor key, cross-site requests are rejected, and the WebSocket survives 70 seconds of idle heartbeat traffic.

The application image and proxy configuration roll back together if the new health/proxy check fails. The old password file and retained secret stay available for a deliberate rollback; they are not used by the public release. Merely updating CloudFormation does not publish the new application.

## Runtime behavior

- **Demo defaults on each connection.** It streams clearly labeled preset examples and emits real UI handoff/status events without invoking a model.
- **Live mode uses visitor credentials.** The key is kept only in that connection's memory and sent to the selected official provider endpoint. It is not saved to disk or browser storage, printed in logs, or shared with another connection. Raw provider error bodies are discarded because they can echo sensitive request content.
- No public message can invoke the local CLI runner, credential files, uploads, shell commands or project filesystem. The local server remains available with `npm run start:local` on a trusted computer.
- Disconnecting, switching back to Demo or 15 minutes without client activity destroys the connection's state and aborts active calls. Sessions and chat history do not survive refresh/restart.
- At most 64 connections and 8 concurrent provider requests, 60 messages/minute per connection, 32 KiB WebSocket messages, 8,000-character prompts, bounded chat context, 2,048 output tokens per API call and a 90-second provider timeout. PM workflows use at most three unique teammate tasks. These limits bound work on the selected small instance; they are not a load-test result.
- Uploads are disabled in the client, Node server and public Nginx proxy, with the requested explanation: **“File uploads are disabled to reduce running costs.”** Rejection happens before parsing/storing a body. Live mode returns actual AI chat/code proposals, not executed code or verified file changes.
- Markdown is reconstructed from permitted DOM elements; model-supplied scripts, event handlers, embeds and unsafe link protocols cannot execute.

Provider implementations follow [OpenAI Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses) (`store:false`, no tools) and [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming). Model IDs are editable; account permissions, quotas and provider model availability determine whether a visitor's request succeeds. A stored key is labeled unverified until a successful response.

## Infrastructure and cost

The existing host remains one Amazon Linux 2023 ARM64 EC2 `t4g.small` (2 GiB), Docker, Nginx, CloudFront HTTPS and a VPC origin. The instance accepts port 80 only from the CloudFront service-managed group. No public SSH or port 3000 is opened. There is no NAT gateway, ALB, RDS or EKS.

The public Docker image contains the Node app and production dependencies, without global coding CLIs. It runs as non-root with a read-only app filesystem, dropped Linux capabilities, no Docker socket, blocked instance metadata, rotating logs, 1,400 MiB RAM / 2,800 MiB combined RAM+swap, a 256 MiB `/tmp` filesystem and a 16 MiB temporary home. The public container does not mount the owner's old persistent workspace or provider environment file.

Demo incurs no model API charges. Live model calls use the visitor's account; hosting costs still belong to the owner. Upload disabling reduces storage/processing exposure but does not eliminate EC2, disk, IPv4, CloudFront or retained-secret charges. The previous T4g trial discussion remains conditional on AWS terms and the account's remaining allowance; no current bill or zero-cost hosting is claimed. See [EC2 trial terms](https://aws.amazon.com/ec2/faqs/), [EBS](https://aws.amazon.com/ebs/pricing/), [IPv4](https://aws.amazon.com/vpc/pricing/) and [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/).

## Operations and rollback

- Use **EC2 → Connect → Session Manager**. Startup logs: `/var/log/cloud-init-output.log`; app logs: `sudo docker logs agents-office`; active proxy: `/etc/nginx/nginx.conf`.
- The publisher's existing OIDC role can run only this instance's constrained deployment document. It cannot update CloudFormation or EC2 networking. No new IAM permission is required for this rollout.
- A deliberate old-release deployment selects that release's private `nginx.conf` and restores its password gate. Do not expose the old CLI server through the public proxy.
- Initial stack bootstrap still creates the protected entry; the first publishing run activates the public configuration after app health succeeds. New stacks still require the CloudFront service-group parameter to be filled after AWS creates that managed group.
- Stack deletion retains the root EBS volume and original login secret; inspect and deliberately retire or back up retained resources. Old Docker images also remain for rollback: monitor the 20 GiB disk and remove obsolete images deliberately before it fills.
- This remains a single small host without an automatic backup or availability guarantee. No capacity claim for a large public audience is made.

AWS references: [SSM document version updates](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ssm-document.html), [CloudFront VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html).
