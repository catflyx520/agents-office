#!/bin/bash
set -euo pipefail
export AWS_DEFAULT_REGION='__REGION__'
stack_name='__STACK_NAME__'
signal_status() {
  /opt/aws/bin/cfn-signal -e "$?" --stack "$stack_name" --resource OfficeInstance --region "$AWS_DEFAULT_REGION"
}
dnf install -y aws-cfn-bootstrap
trap signal_status EXIT
dnf install -y docker nginx httpd-tools jq
systemctl enable --now docker amazon-ssm-agent
mkdir -p /etc/agents-office /var/lib/agents-office/home /opt/agents-office/releases
touch /etc/agents-office/providers.env
chmod 600 /etc/agents-office/providers.env
chown -R 1000:1000 /var/lib/agents-office/home
chmod 700 /var/lib/agents-office/home
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  printf '/swapfile swap swap defaults 0 0\n' >> /etc/fstab
fi
# The app container never receives an instance role or the host Docker socket.
iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null \
  || iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT
cat > /etc/systemd/system/office-metadata-block.service <<'UNIT'
[Unit]
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C DOCKER-USER -d 169.254.169.254/32 -j REJECT 2>/dev/null || iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT'
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable office-metadata-block.service
release_sha='__RELEASE_COMMIT__'
curl --fail --silent --show-error --location --retry 3 \
  "https://api.github.com/repos/catflyx520/agents-office/tarball/$release_sha" \
  | tar -xz --strip-components=1 -C /opt/agents-office
install -m 755 /opt/agents-office/deployment/deploy-release.sh /opt/agents-office/deploy-release.sh
install -m 644 /opt/agents-office/deployment/nginx.conf /etc/nginx/nginx.conf
login_password="$(aws secretsmanager get-secret-value --secret-id '__LOGIN_SECRET_ARN__' --query SecretString --output text | jq -r .password)"
printf '%s\n' "$login_password" | htpasswd -Bci /etc/nginx/office.htpasswd office
unset login_password
chown root:nginx /etc/nginx/office.htpasswd
chmod 640 /etc/nginx/office.htpasswd
/opt/agents-office/deploy-release.sh "$release_sha"
nginx -t
systemctl enable --now nginx
test "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1/)" = 401
