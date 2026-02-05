#!/bin/bash
# Codex Orchestrator - Installation Script
# Installs the codex-agent CLI and its dependencies.
# Uses only official package managers. No third-party scripts.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

INSTALL_DIR="${CODEX_ORCHESTRATOR_HOME:-$HOME/.codex-orchestrator}"
REPO_URL="https://github.com/kingbootoshi/codex-orchestrator.git"

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; }

# -------------------------------------------------------------------
# Platform detection
# -------------------------------------------------------------------
detect_platform() {
  case "$(uname -s)" in
    Linux*)   PLATFORM="linux" ;;
    Darwin*)  PLATFORM="macos" ;;
    CYGWIN*|MINGW*|MSYS*)
      error "Windows is not directly supported."
      echo ""
      echo "Please use WSL (Windows Subsystem for Linux):"
      echo "  1. Install WSL: wsl --install"
      echo "  2. Open a WSL terminal"
      echo "  3. Re-run this script inside WSL"
      exit 1
      ;;
    *)
      error "Unsupported platform: $(uname -s)"
      exit 1
      ;;
  esac

  info "Platform: $PLATFORM ($(uname -m))"
}

# -------------------------------------------------------------------
# Detect package manager (Linux only)
# -------------------------------------------------------------------
detect_linux_pkg_manager() {
  if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
  elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
  elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
  elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
  elif command -v apk &>/dev/null; then
    PKG_MANAGER="apk"
  elif command -v zypper &>/dev/null; then
    PKG_MANAGER="zypper"
  else
    PKG_MANAGER=""
  fi
}

# -------------------------------------------------------------------
# Check and install tmux
# -------------------------------------------------------------------
check_tmux() {
  if command -v tmux &>/dev/null; then
    success "tmux: $(tmux -V)"
    return 0
  fi

  warn "tmux not found. Installing..."

  if [ "$PLATFORM" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      error "Homebrew not found. Install it from https://brew.sh then re-run this script."
      exit 1
    fi
    brew install tmux
  elif [ "$PLATFORM" = "linux" ]; then
    detect_linux_pkg_manager
    case "$PKG_MANAGER" in
      apt)     sudo apt-get update && sudo apt-get install -y tmux ;;
      dnf)     sudo dnf install -y tmux ;;
      yum)     sudo yum install -y tmux ;;
      pacman)  sudo pacman -S --noconfirm tmux ;;
      apk)     sudo apk add tmux ;;
      zypper)  sudo zypper install -y tmux ;;
      *)
        error "No supported package manager found. Install tmux manually:"
        echo "  https://github.com/tmux/tmux/wiki/Installing"
        exit 1
        ;;
    esac
  fi

  if command -v tmux &>/dev/null; then
    success "tmux installed: $(tmux -V)"
  else
    error "tmux installation failed."
    exit 1
  fi
}

# -------------------------------------------------------------------
# Check and install Bun
# -------------------------------------------------------------------
check_bun() {
  if command -v bun &>/dev/null; then
    success "bun: $(bun --version)"
    return 0
  fi

  warn "Bun not found. Installing via official installer..."
  echo ""
  info "Bun install page: https://bun.sh"
  echo ""

  # Official Bun installer from bun.sh
  curl -fsSL https://bun.sh/install | bash

  # Source the updated profile so bun is on PATH
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if command -v bun &>/dev/null; then
    success "bun installed: $(bun --version)"
  else
    error "Bun installation failed. Install manually from https://bun.sh"
    exit 1
  fi
}

# -------------------------------------------------------------------
# Check for OpenAI Codex CLI
# -------------------------------------------------------------------
check_codex() {
  if command -v codex &>/dev/null; then
    success "codex CLI: found"
    return 0
  fi

  warn "OpenAI Codex CLI not found."
  echo ""
  echo "The Codex CLI is the coding agent that codex-orchestrator controls."
  echo ""
  echo "Install it with npm:"
  echo "  npm install -g @openai/codex"
  echo ""
  echo "Then authenticate with your OpenAI account:"
  echo "  codex --login"
  echo ""
  echo "More info: https://github.com/openai/codex"
  echo ""

  read -p "Do you want to install it now with npm? [y/N] " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    if command -v npm &>/dev/null; then
      npm install -g @openai/codex
      if command -v codex &>/dev/null; then
        success "codex CLI installed"
        echo ""
        warn "You still need to authenticate: codex --login"
      else
        error "Codex CLI installation failed."
        exit 1
      fi
    else
      error "npm not found. Install Node.js first: https://nodejs.org"
      exit 1
    fi
  else
    warn "Skipping Codex CLI install. You'll need it before using codex-agent."
  fi
}

# -------------------------------------------------------------------
# Install codex-orchestrator
# -------------------------------------------------------------------
install_orchestrator() {
  if [ -d "$INSTALL_DIR" ]; then
    info "Updating existing installation at $INSTALL_DIR"
    cd "$INSTALL_DIR"
    git pull --ff-only origin main
  else
    info "Cloning codex-orchestrator to $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  info "Installing dependencies..."
  bun install

  # Create symlink
  local BIN_TARGET="/usr/local/bin/codex-agent"

  if [ -L "$BIN_TARGET" ] || [ -f "$BIN_TARGET" ]; then
    info "codex-agent already on PATH at $BIN_TARGET"
  else
    info "Creating symlink: $BIN_TARGET -> $INSTALL_DIR/bin/codex-agent"
    if sudo ln -sf "$INSTALL_DIR/bin/codex-agent" "$BIN_TARGET" 2>/dev/null; then
      success "codex-agent linked to $BIN_TARGET"
    else
      warn "Could not create symlink (no sudo access)."
      echo ""
      echo "Add to your PATH manually:"
      echo "  export PATH=\"$INSTALL_DIR/bin:\$PATH\""
      echo ""
      echo "Or add that line to your shell profile (~/.bashrc, ~/.zshrc, etc.)"
    fi
  fi
}

# -------------------------------------------------------------------
# Verify installation
# -------------------------------------------------------------------
verify() {
  echo ""
  info "Running health check..."
  echo ""

  if command -v codex-agent &>/dev/null; then
    codex-agent health
  elif [ -f "$INSTALL_DIR/bin/codex-agent" ]; then
    "$INSTALL_DIR/bin/codex-agent" health
  else
    error "codex-agent binary not found after installation."
    exit 1
  fi

  echo ""
  success "Installation complete!"
  echo ""
  echo "Quick start:"
  echo "  codex-agent start \"Review this codebase for issues\" --map"
  echo "  codex-agent jobs --json"
  echo "  codex-agent capture <jobId>"
  echo ""

  if ! command -v codex &>/dev/null; then
    warn "Reminder: Install the Codex CLI before using codex-agent:"
    echo "  npm install -g @openai/codex"
    echo "  codex --login"
  fi
}

# -------------------------------------------------------------------
# Main
# -------------------------------------------------------------------
main() {
  echo ""
  echo "========================================="
  echo "  Codex Orchestrator - Setup"
  echo "========================================="
  echo ""

  detect_platform
  echo ""

  check_tmux
  check_bun
  check_codex

  echo ""
  install_orchestrator

  verify
}

main "$@"
