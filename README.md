# Tauri + Vanilla TS

This template should help get you started developing with Tauri in vanilla HTML, CSS and Typescript.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Development Setup

### Method 1: Using Dev Container

1. Open this project in VS Code
2. Install the "Dev Containers" extension
3. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
4. Select "Dev Containers: Reopen in Container"
5. Wait for the container to build (this may take a few minutes on first run)
6. Run the development server:
   ```bash
   npm run tauri dev
   ```
7. Open `http://localhost:6080` in your browser
8. Login with password: `vscode`
9. The Tauri desktop app will appear in the virtual desktop environment

### Method 2: Running on Host Machine

#### Prerequisites

**macOS:**
```bash
# Install Xcode Command Line Tools
xcode-select --install
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

**Windows:**
- Install [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- Install [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

#### Install Dependencies and Run

```bash
# Install Node.js dependencies
npm install

# Run development server
npm run tauri dev
```

The desktop app will launch automatically on your host machine.
