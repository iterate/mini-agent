#!/bin/bash
set -e
# Install dependencies for the project

# Install Doppler only in Claude Cloud environment
if [ -n "$CLAUDE_CLOUD" ]; then
  if ! command -v doppler &> /dev/null; then
    echo "Installing Doppler..."
    mkdir -p ~/.local/bin
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh -s -- --install-path ~/.local/bin
    echo "Doppler installed successfully"
  else
    echo "Doppler already installed"
  fi

  # Clone Effect reference repositories for CLAUDE.md tooling
  EFFECT_DIR="$HOME/src/github.com/Effect-TS/effect"
  if [ ! -d "$EFFECT_DIR" ]; then
    echo "Cloning Effect-TS/effect..."
    mkdir -p "$(dirname "$EFFECT_DIR")"
    git clone --depth 1 https://github.com/Effect-TS/effect.git "$EFFECT_DIR"
    echo "Effect-TS/effect cloned successfully"
  else
    echo "Effect-TS/effect already present"
  fi

  PATTERNS_DIR="$HOME/src/github.com/PaulJPhilp/EffectPatterns"
  if [ ! -d "$PATTERNS_DIR" ]; then
    echo "Cloning PaulJPhilp/EffectPatterns..."
    mkdir -p "$(dirname "$PATTERNS_DIR")"
    git clone --depth 1 https://github.com/PaulJPhilp/EffectPatterns.git "$PATTERNS_DIR"
    echo "EffectPatterns cloned successfully"
  else
    echo "EffectPatterns already present"
  fi
fi

# Install project dependencies
echo "Installing project dependencies..."
bun install
