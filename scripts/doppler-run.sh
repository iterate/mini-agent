#!/bin/bash
# Wrapper to ensure doppler is in PATH (for Claude Cloud where it's installed to ~/bin)
export PATH="$HOME/bin:$PATH"
exec doppler "$@"
