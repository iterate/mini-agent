#!/bin/bash
set -e
# Install doppler
(curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh || wget -t 3 -qO- https://cli.doppler.com/install.sh) | sudo sh


# Install bun
curl -fsSL https://bun.com/install | bash

# For stupid reasons secrets are shared across all repos in a Cursor team, and because we already used Doppler token in another repo and it's a different Doppler token, we have to use mini_agent_doppler_token here.
echo 'export DOPPLER_TOKEN="$MINI_AGENT_DOPPLER_TOKEN"' >> ~/.bashrc
