#!/bin/bash
# Install dependencies for the project

# Install Doppler only in Claude Cloud environment
if [ -n "$CLAUDE_CLOUD" ]; then
  if ! command -v doppler &> /dev/null; then
    echo "Installing Doppler..."
    mkdir -p ~/bin
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh -s -- --install-path ~/bin
    export PATH="$HOME/bin:$PATH"
    echo "Doppler installed successfully"
  else
    echo "Doppler already installed"
  fi
fi

# Install project dependencies
echo "Installing project dependencies..."
bun install

exit 0
