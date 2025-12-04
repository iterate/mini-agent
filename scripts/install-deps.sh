#!/bin/bash
# Install dependencies for the project

# Install Doppler if not already present
if ! command -v doppler &> /dev/null; then
  echo "Installing Doppler..."
  curl -sLf --retry 3 --tlsv1.2 --proto "=https" \
    "https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key" | \
    sudo gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg

  echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" | \
    sudo tee /etc/apt/sources.list.d/doppler-cli.list

  sudo apt-get update && sudo apt-get install -y doppler
  echo "Doppler installed successfully"
else
  echo "Doppler already installed"
fi

# Install project dependencies
echo "Installing project dependencies..."
bun install

exit 0
