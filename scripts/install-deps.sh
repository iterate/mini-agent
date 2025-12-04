#!/bin/bash
set -e
# Install dependencies for the project

# Install Doppler only in Claude Cloud environment
if [ -n "$CLAUDE_CLOUD" ]; then
  if ! command -v doppler &> /dev/null; then
    echo "Installing Doppler..."
    mkdir -p ~/bin
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh -s -- --install-path ~/bin
    # Add ~/bin to PATH persistently for this session
    if ! grep -q 'export PATH="$HOME/bin:$PATH"' ~/.bashrc 2>/dev/null; then
      echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
    fi
    export PATH="$HOME/bin:$PATH"
    echo "Doppler installed successfully"
  else
    echo "Doppler already installed"
  fi
fi

# Install project dependencies
echo "Installing project dependencies..."
bun install
